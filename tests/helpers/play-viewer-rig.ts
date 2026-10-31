/**
 * Play's viewer over recording fakes: the game's view, the bar's layer, the window, the gallery,
 * the comments, the coin client behind a game's purchase sheet, the Genex sign-in, the browser and
 * a clock the test moves. Every call a fake takes is written to `log` in order.
 */
import type { PlayTicket, PlayWorld } from "../../src/main/play/gallery.ts";
import { TicketStatus } from "../../src/main/play/gallery.ts";
import { type CoinIntent, CoinIntentStatus } from "../../src/main/play/coin.ts";
import type { ViewerCoin } from "../../src/main/play/viewer-purchase.ts";
import { type PlayViewerDeps, playViewer } from "../../src/main/play/viewer.ts";
import type { PlayComment } from "../../src/shared/play-comments.ts";
import type { PlayBarState, PlayViewerEvent } from "../../src/shared/play.ts";
import type { PlayPurchaseSheet } from "../../src/shared/play-purchase.ts";

export const WINDOW = { width: 1440, height: 900 };

export const MINTED: PlayTicket = { status: TicketStatus.Minted, ticket: "T1" };
export const SIGNED_OUT: PlayTicket = { status: TicketStatus.SignedOut };
export const NOT_MINTED: PlayTicket = { status: TicketStatus.NotMinted };

/** An Esc press in the game: down, or up again. */
export const esc = (type: "keyDown" | "keyUp") => ({ type, key: "Escape", isAutoRepeat: false });

export const WORLD: PlayWorld = {
  id: "cm1",
  slug: "lost-cathedral",
  title: "Lost Cathedral",
  multiplayer: true,
  likes: 3,
  liked: false,
  remixable: true,
  cloneUrl: "https://git.genex.games/u-1/lost-cathedral.git",
  author: "Simeon M",
  authorId: null,
  plays: 5300,
  online: 8,
  comments: 2,
  coverUrl: null,
};

/** The account's coin before the test spends any. */
export const WALLET = 1240;
/** How long genex.games gives a purchase before it lapses (its intent TTL). */
export const INTENT_TTL_MS = 120_000;

/** A purchase of Lost Cathedral's, as the coin client reads it: 75 coin, open for two minutes from the clock's start. */
export const INTENT: CoinIntent = {
  id: "pi_1",
  status: CoinIntentStatus.RequiresConfirmation,
  projectId: WORLD.id,
  dynamic: true,
  name: "Lantern oil",
  description: "Keeps the lantern lit for one more floor.",
  iconUrl: null,
  quantity: 1,
  unitPriceCoins: 75,
  totalCoins: 75,
  usdCents: 75,
  expiresAt: INTENT_TTL_MS,
  failure: null,
};

/** A fake clock whose timers run when the test advances it. */
export function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    clock: {
      setTimeout: (run: () => void, ms: number) => {
        const id = next++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clearTimeout: (id: unknown) => void timers.delete(id as number),
      now: () => now,
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

/** Let the viewer's awaited calls settle. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A comment as the fake genex.games saves one. */
export const saved = (body: string): PlayComment => ({
  id: "c9",
  body,
  at: 0,
  author: { id: "u-1", name: "Rab", imageUrl: null, avatarVariant: 0 },
  mine: true,
});

/** What a rig may change from its fakes' defaults. */
export type RigOverrides = Partial<PlayViewerDeps["gallery"]> & {
  web?: string;
  comments?: Partial<PlayViewerDeps["comments"]>;
  barFocused?: () => boolean;
  coin?: Partial<ViewerCoin>;
  /** A web game's native app on this computer, for the bar's pill. */
  nativeApp?: PlayViewerDeps["nativeApp"];
  /** Whether a game sells items, for the bar's Store door; the app's page takes the keyboard as `page.focus`. */
  storeShown?: (slug: string) => Promise<boolean>;
};

/**
 * The coin client's fake: Lost Cathedral's purchase by any id, a wallet a confirm spends from, and a
 * cancel that cancels, unless the test answers a call itself. Every call is logged as
 * `coin.<call> <id>`, the test's answers too.
 */
function fakeCoin(log: string[], overrides: Partial<ViewerCoin> = {}): ViewerCoin {
  let wallet = WALLET;
  const answers: ViewerCoin = {
    intent: async (id) => ({ ...INTENT, id }),
    balance: async () => wallet,
    confirm: async (intent) => {
      wallet -= intent.totalCoins;
    },
    cancel: async () => CoinIntentStatus.Canceled,
    ...overrides,
  };
  return {
    intent: (id) => {
      log.push(`coin.intent ${id}`);
      return answers.intent(id);
    },
    balance: () => {
      log.push("coin.balance");
      return answers.balance();
    },
    confirm: (intent) => {
      log.push(`coin.confirm ${intent.id}`);
      return answers.confirm(intent);
    },
    cancel: (id) => {
      log.push(`coin.cancel ${id}`);
      return answers.cancel(id);
    },
  };
}

/** A viewer over recording fakes. */
export function rig(overrides: RigOverrides = {}) {
  const { clock, advance } = fakeClock();
  const log: string[] = [];
  const events: PlayViewerEvent[] = [];
  const copied: string[] = [];
  const opened: string[] = [];
  const pages: string[] = [];
  const deps: PlayViewerDeps = {
    gallery: {
      world: async () => WORLD,
      ticket: async () => MINTED,
      setLiked: async (_id, liked) => ({ liked, likes: liked ? 4 : 3 }),
      inviteCode: async () => "abc",
      ...overrides,
    },
    gameUrl: (slug, ticket) => `game:${slug}:${ticket ?? "guest"}`,
    window: {
      contentSize: () => WINDOW,
      buttons: (visible) => log.push(`buttons ${visible ? "shown" : "hidden"}`),
    },
    game: {
      open: (url, _slug, bounds) => {
        opened.push(url);
        log.push(`game.open ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
      },
      show: (bounds) => log.push(`game.show ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`),
      hide: () => log.push("game.hide"),
      focus: () => log.push("game.focus"),
      fullScreen: () => log.push("game.fullScreen"),
      close: () => log.push("game.close"),
    },
    bar: {
      show: (bounds) => log.push(`bar.show ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`),
      hide: () => log.push("bar.hide"),
      focus: () => log.push("bar.focus"),
      focused: overrides.barFocused ?? (() => false),
      warm: () => log.push("bar.warm"),
      reload: () => log.push("bar.reload"),
    },
    comments: {
      list: async (id, cursor) => {
        log.push(`comments.list ${id} ${cursor ?? "first"}`);
        return { items: [], nextCursor: null };
      },
      post: async (id, body) => {
        log.push(`comments.post ${id}`);
        return saved(String(body));
      },
      remove: async (id, commentId) => void log.push(`comments.remove ${id} ${String(commentId)}`),
      ...overrides.comments,
    },
    coin: fakeCoin(log, overrides.coin),
    account: { signIn: () => log.push("account.signIn") },
    openPage: (url) => pages.push(url),
    clipboard: (text) => copied.push(text),
    web: overrides.web ?? "https://genex.games",
    emit: (event) => events.push(event),
    clock,
    // Voice chat has its own suite (play-mic.test.ts); these games never ask for a microphone.
    mic: {
      access: async () => true,
      command: () => {},
      menu: () => {},
      openSettings: () => {},
      store: { on: () => false, setOn: () => {}, device: () => null, setDevice: () => {} },
    },
    ...(overrides.nativeApp ? { nativeApp: overrides.nativeApp } : {}),
    ...(overrides.storeShown
      ? { store: { shown: overrides.storeShown, focusPage: () => log.push("page.focus") } }
      : {}),
  };
  const viewer = playViewer(deps);
  /** The header as last drawn. */
  const bar = (): PlayBarState | undefined => events.findLast((event) => event.bar)?.bar;
  /** The purchase sheet as last drawn, or null with none. */
  const sheet = (): PlayPurchaseSheet | null => bar()?.purchase ?? null;
  return { viewer, log, events, bar, sheet, copied, opened, pages, advance, now: clock.now };
}
