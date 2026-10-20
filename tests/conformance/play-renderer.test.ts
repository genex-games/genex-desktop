/**
 * Play in the renderer: a card's count reads short (999, 2.6k, 1.4M) and never goes negative; Recent
 * keeps the newest game first, once each, at most RECENT_MAX of them, and reads back from storage
 * only entries that name a game. A tab's first page replaces what it had and a further page adds
 * only the games it did not have; a player count changes only the multiplayer games it is about.
 * The sidebar's Genex card shows once: until the first sign-in or until it is dismissed. The
 * store reads a tab once while it is on its way, again only once it is stale or forced, keeps the
 * games it has when a read fails, counts only multiplayer games, and opening a game shows its cover
 * at once, leads Recent (remembered in storage) and turns to Failed when main refuses it. The window's
 * drag regions give way while the viewer's native views may cover it, and the guest card's Sign in
 * waits in the store until the shell has run it once. A cover the window has shown starts shown
 * when Play draws it again, remembering the most recent covers only.
 */
import assert from "node:assert/strict";
import { NativeSessionPhase, NO_INSTALLS, SessionAction } from "../../src/shared/play-native.ts";
import { describe, it } from "node:test";
import {
  BAR_AT_TOP,
  barAfterScroll,
  countedSlugs,
  createShownCovers,
  dismissPlayPromo,
  EMPTY_FEED,
  type FeedState,
  FeedStatus,
  formatCount,
  escapeLeaves,
  justLiked,
  nativeViewsUp,
  noteOn,
  PlateState,
  plateState,
  NoteLook,
  PLAY_PROMO_DONE,
  type PlayRecentEntry,
  playPromoDismissed,
  playPromoRetires,
  playPromoVisible,
  RECENT_MAX,
  readRecent,
  shelfTabs,
  type ViewerShown,
  viewerAfter,
  withOnline,
  withPage,
  withRecent,
  writeRecent,
} from "../../src/renderer/play/play-model.ts";
import { BAYER_8, DEVELOP_DONE_MS, ditherSource, drawDevelop, revealAt } from "../../src/renderer/play/dither.ts";
import {
  besideRemix,
  remixCovers,
  remixLine,
  remixSegments,
  remixShare,
  stillWithRemix,
} from "../../src/renderer/play/remix-model.ts";
import { StepState } from "../../src/renderer/ui/step-bar.ts";
import { PlayChangeOutcome, type PlayGameChange } from "../../src/shared/play-manage.ts";
import {
  createPlayStore,
  FEED_STALE_MS,
  feedFailed,
  feedOf,
  feedRequested,
  gameOpened,
  initialPlay,
  installAnswered,
  onlineCounted,
  PlayPage,
  remixClosed,
  remixEnded,
  remixFailureTold,
  remixOpened,
  remixProgressed,
  remixReturnedTo,
  remixSetAside,
  remixStarted,
  type RemixUnderway,
  RemixView,
  shelfChosen,
  shelvesLoaded,
  viewerReported,
  installsReported,
  sessionsReported,
} from "../../src/renderer/state/play.ts";
import { type KeyValueStorage, STORAGE_KEYS } from "../../src/renderer/storage.ts";
import {
  PlayCategory,
  PlayControl,
  type PlayFeedPage,
  type PlayFeedRequest,
  type PlayGame,
  type PlayGameDetail,
  PlayNote,
  PlayShelf,
  type PlayShelves,
  PlayViewerPhase,
  RemixStep,
} from "../../src/shared/play.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";

type PlayApi = Parameters<typeof createPlayStore>[0];

/** A storage held in memory, with what it holds open to the test. */
function memory(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

/** A storage every call to which throws, as a locked-down window's does. */
const refusingStorage: KeyValueStorage = {
  getItem: () => {
    throw new Error("storage denied");
  },
  setItem: () => {
    throw new Error("storage denied");
  },
  removeItem: () => {
    throw new Error("storage denied");
  },
};

function game(slug: string, overrides: Partial<PlayGame> = {}): PlayGame {
  return {
    id: `id-${slug}`,
    slug,
    title: slug.toUpperCase(),
    description: "",
    coverUrl: null,
    clipUrl: null,
    multiplayer: false,
    plays: 0,
    online: null,
    author: { id: null, name: "Author", imageUrl: null },
    remixable: false,
    assetKind: null,
    ...overrides,
  };
}

const entry = (slug: string): PlayRecentEntry => ({ slug, title: slug.toUpperCase(), coverUrl: null });

const page = (games: PlayGame[], nextCursor: string | null = null): PlayFeedPage => ({ games, nextCursor });

const slugsOf = (games: readonly { slug: string }[]): string[] => games.map((item) => item.slug);

/** The shelves before their counts are read: each one's first tab. */
const UNCOUNTED: PlayShelves = {
  counts: { [PlayShelf.Games]: null, [PlayShelf.Tools]: null, [PlayShelf.Assets]: null },
  categories: [PlayCategory.Featured, PlayCategory.Tools, PlayCategory.Assets],
};

/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A play API that records every call and answers with the handlers given (an empty page otherwise). */
function fakeApi(handlers: Partial<PlayApi> = {}) {
  const calls = {
    feed: [] as PlayFeedRequest[],
    shelves: 0,
    online: [] as string[][],
    open: [] as string[],
    remix: [] as string[],
    close: 0,
    manage: [] as Array<{ gameId: string; change: PlayGameChange }>,
    game: [] as string[],
    install: [] as string[],
    cancel: [] as string[],
    uninstall: [] as string[],
    launch: [] as string[],
    session: [] as Array<[string, string]>,
  };
  const api: PlayApi = {
    playFeed: (request) => {
      calls.feed.push(request);
      return handlers.playFeed ? handlers.playFeed(request) : Promise.resolve(page([]));
    },
    playShelves: () => {
      calls.shelves += 1;
      return handlers.playShelves ? handlers.playShelves() : Promise.resolve(UNCOUNTED);
    },
    playOnline: (slugs) => {
      calls.online.push(slugs);
      return handlers.playOnline ? handlers.playOnline(slugs) : Promise.resolve({});
    },
    playOpen: (slug, title) => {
      calls.open.push(slug);
      return handlers.playOpen ? handlers.playOpen(slug, title) : Promise.resolve();
    },
    playClose: () => {
      calls.close += 1;
      return Promise.resolve();
    },
    playRemix: (slug) => {
      calls.remix.push(slug);
      return handlers.playRemix ? handlers.playRemix(slug) : Promise.resolve(`${slug}-copy`);
    },
    assetLibrary: () => Promise.resolve({ assets: [], nextCursor: null }),
    playCatalog: () => Promise.resolve([]),
    playManage: (gameId, change) => {
      calls.manage.push({ gameId, change });
      return handlers.playManage
        ? handlers.playManage(gameId, change)
        : Promise.resolve({ outcome: PlayChangeOutcome.Done });
    },
    playGame: (slug) => {
      calls.game.push(slug);
      return handlers.playGame ? handlers.playGame(slug) : Promise.reject(new Error("no page"));
    },
    playInstalls: () => (handlers.playInstalls ? handlers.playInstalls() : Promise.resolve(NO_INSTALLS)),
    playSessions: () => (handlers.playSessions ? handlers.playSessions() : Promise.resolve([])),
    playInstall: async (slug) => {
      calls.install.push(slug);
    },
    playInstallCancel: async (slug) => {
      calls.cancel.push(slug);
    },
    playUninstall: async (slug) => {
      calls.uninstall.push(slug);
    },
    playLaunch: async (slug) => {
      calls.launch.push(slug);
    },
    playSession: async (slug, action) => {
      calls.session.push([slug, action]);
    },
  };
  return { api, calls };
}

/** A clock the test moves by hand. */
function manualClock(start = 1_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("Play counts", () => {
  it("reads a count short: whole below a thousand, one decimal rounded down below ten, whole above", () => {
    const table: [number, string][] = [
      [0, "0"],
      [999, "999"],
      [1000, "1k"],
      [2682, "2.6k"],
      [9999, "9.9k"],
      [12000, "12k"],
      [999_999, "999k"],
      [1_000_000, "1M"],
      [1_400_000, "1.4M"],
      [-1, "0"],
      [Number.NaN, "0"],
      [Number.POSITIVE_INFINITY, "0"],
    ];
    for (const [value, expected] of table) assert.equal(formatCount(value), expected, `formatCount(${value})`);
  });
});

describe("Play Recent", () => {
  it("puts the opened game first, once, without changing the list it was given", () => {
    const list = [entry("a"), entry("b"), entry("c")];
    const reopened = { slug: "b", title: "B again", coverUrl: "https://cdn.genex.technology/b.webp" };
    const next = withRecent(list, reopened);
    assert.deepEqual(next, [reopened, entry("a"), entry("c")]);
    assert.deepEqual(slugsOf(list), ["a", "b", "c"]);
  });

  it(`keeps at most ${RECENT_MAX} games, dropping the oldest`, () => {
    const full = Array.from({ length: RECENT_MAX }, (_, index) => entry(`g${index}`));
    const added = withRecent(full, entry("new"));
    assert.equal(added.length, RECENT_MAX);
    assert.equal(added[0]?.slug, "new");
    assert.equal(added.at(-1)?.slug, `g${RECENT_MAX - 2}`);
    const reopened = withRecent(full, entry(`g${RECENT_MAX - 1}`));
    assert.equal(reopened.length, RECENT_MAX, "reopening a remembered game loses nothing");
    assert.equal(reopened[0]?.slug, `g${RECENT_MAX - 1}`);
  });

  it("reads back only stored entries that name a game, and never writes while reading", () => {
    const valid = { slug: "ok", title: "OK", coverUrl: null };
    const withCover = { slug: "good-cover", title: "Good", coverUrl: "https://cdn.genex.technology/c.webp" };
    const table: [string, string | null, string[]][] = [
      ["nothing stored", null, []],
      ["not JSON", "{not json", []],
      ["JSON null", "null", []],
      ["a string", '"ok"', []],
      ["an object, not a list", JSON.stringify(valid), []],
      [
        "a list with hostile entries",
        JSON.stringify([
          { slug: "../x", title: "Escape", coverUrl: null },
          valid,
          { slug: "a/b", title: "Slash", coverUrl: null },
          { slug: "UPPER", title: "Upper", coverUrl: null },
          { slug: "-dash", title: "Dash", coverUrl: null },
          { slug: "no-title", coverUrl: null },
          { slug: "empty-title", title: "", coverUrl: null },
          { slug: "number-title", title: 7, coverUrl: null },
          { slug: "number-cover", title: "N", coverUrl: 5 },
          { slug: "object-cover", title: "O", coverUrl: { src: "x" } },
          { slug: "missing-cover", title: "M" },
          null,
          7,
          "ok",
          [valid],
          withCover,
        ]),
        ["ok", "good-cover"],
      ],
      ["the same game twice", JSON.stringify([valid, withCover, { ...valid, title: "Again" }]), ["ok", "good-cover"]],
    ];
    for (const [name, raw, expected] of table) {
      const storage = memory(raw === null ? {} : { [STORAGE_KEYS.playRecent]: raw });
      const before = new Map(storage.values);
      assert.deepEqual(slugsOf(readRecent(storage)), expected, name);
      assert.deepEqual(storage.values, before, `${name}: reading wrote nothing`);
    }
    assert.deepEqual(readRecent(refusingStorage), [], "a storage that throws reads as empty");
    assert.deepEqual(readRecent(null), [], "no storage reads as empty");
  });

  it(`reads back at most ${RECENT_MAX} games`, () => {
    const stored = Array.from({ length: RECENT_MAX + 8 }, (_, index) => entry(`g${index}`));
    const storage = memory({ [STORAGE_KEYS.playRecent]: JSON.stringify(stored) });
    const read = readRecent(storage);
    assert.equal(read.length, RECENT_MAX);
    assert.deepEqual(read, stored.slice(0, RECENT_MAX));
  });

  it("writes Recent so that it reads back the same", () => {
    const storage = memory();
    const list = [entry("a"), { slug: "b", title: "B", coverUrl: "https://cdn.genex.technology/b.webp" }];
    writeRecent(list, storage);
    assert.deepEqual(readRecent(storage), list);
    assert.doesNotThrow(() => writeRecent(list, refusingStorage), "a storage that throws is ignored");
  });
});

describe("Play pages", () => {
  it("replaces a tab with its first page and marks it ready at that time", () => {
    const before: FeedState = {
      games: [game("old")],
      nextCursor: "old-cursor",
      status: FeedStatus.Failed,
      loadingMore: true,
      moreFailed: true,
      at: 5,
    };
    const fresh = [game("a"), game("b")];
    const after = withPage(before, page(fresh, "n2"), false, 50);
    assert.deepEqual(after, {
      games: fresh,
      nextCursor: "n2",
      status: FeedStatus.Ready,
      loadingMore: false,
      moreFailed: false,
      at: 50,
    });
    assert.notEqual(after.games, fresh, "the tab keeps its own copy of the page's list");
  });

  it("adds a further page's games the tab does not have yet, keeping when it was first read", () => {
    const first = withPage(EMPTY_FEED, page([game("a"), game("b")], "n2"), false, 50);
    const more = withPage({ ...first, loadingMore: true }, page([game("b"), game("c")], null), true, 99);
    assert.deepEqual(slugsOf(more.games), ["a", "b", "c"]);
    assert.equal(more.nextCursor, null);
    assert.equal(more.status, FeedStatus.Ready);
    assert.equal(more.loadingMore, false);
    assert.equal(more.at, 50);
  });

  it("changes only the multiplayer games whose player count changed", () => {
    const solo = game("solo");
    const duo = game("duo", { multiplayer: true, online: 3 });
    const trio = game("trio", { multiplayer: true, online: 7 });
    const games = [solo, duo, trio];
    const counted = withOnline(games, { solo: 4, duo: 3, trio: 8 });
    assert.notEqual(counted, games);
    assert.equal(counted[0], solo, "a single-player game is never counted");
    assert.equal(counted[1], duo, "an unchanged count keeps the game object");
    assert.equal(counted[2]?.online, 8);
    assert.equal(trio.online, 7, "the given game is not changed in place");
    assert.equal(withOnline(games, { duo: 3, solo: 9 }), games, "nothing changed: the same list");
    assert.equal(withOnline(games, {}), games, "no counts: the same list");
    assert.deepEqual(countedSlugs(games), ["duo", "trio"]);
  });
});

describe("Play's Genex card", () => {
  const ALL = [...Object.values(GenexAccountStatus), null];

  it("never shows once dismissed", () => {
    for (const account of ALL) assert.equal(playPromoVisible({ dismissed: true, account }), false, String(account));
  });

  it("shows to someone who has never signed in, and while their first sign-in waits in the browser", () => {
    assert.equal(playPromoVisible({ dismissed: false, account: GenexAccountStatus.SignedOut }), true);
    assert.equal(playPromoVisible({ dismissed: false, account: GenexAccountStatus.SigningIn }), true);
  });

  it("waits for the account before it shows, and never shows to someone who has signed in", () => {
    for (const account of [null, GenexAccountStatus.SignedIn, GenexAccountStatus.Ended])
      assert.equal(playPromoVisible({ dismissed: false, account }), false, String(account));
  });

  it("goes for good at the first sign-in, and a sign-in that ended was one", () => {
    assert.equal(playPromoRetires(GenexAccountStatus.SignedIn), true);
    assert.equal(playPromoRetires(GenexAccountStatus.Ended), true);
    for (const account of [null, GenexAccountStatus.SignedOut, GenexAccountStatus.SigningIn])
      assert.equal(playPromoRetires(account), false, String(account));
  });

  it("stays dismissed in storage, and a storage that cannot keep it reads as not dismissed", () => {
    const storage = memory();
    assert.equal(playPromoDismissed(storage), false);
    dismissPlayPromo(storage);
    assert.equal(storage.values.get(STORAGE_KEYS.playPromo), PLAY_PROMO_DONE);
    assert.equal(playPromoDismissed(storage), true);
    assert.equal(playPromoDismissed(memory({ [STORAGE_KEYS.playPromo]: "other" })), false);
    assert.doesNotThrow(() => dismissPlayPromo(refusingStorage));
    assert.equal(playPromoDismissed(refusingStorage), false);
    assert.equal(playPromoDismissed(null), false);
  });
});

describe("Play's viewer cover", () => {
  const shown: ViewerShown = { slug: "a", title: "A", coverUrl: null, phase: PlayViewerPhase.Loading, openId: 2 };
  const fresh: ViewerShown = { ...shown, openId: null };

  it("ignores news about another game and about no game shown", () => {
    assert.equal(viewerAfter(shown, { slug: "b", openId: 2, phase: PlayViewerPhase.Closed }), shown);
    assert.equal(viewerAfter(null, { slug: "a", openId: 2, phase: PlayViewerPhase.Playing }), null);
  });

  it("shows nothing once closed, keeps itself for the same phase and takes a new one", () => {
    assert.equal(viewerAfter(shown, { slug: "a", openId: 2, phase: PlayViewerPhase.Closed }), null);
    assert.equal(viewerAfter(shown, { slug: "a", openId: 2, phase: PlayViewerPhase.Loading }), shown);
    assert.deepEqual(viewerAfter(shown, { slug: "a", openId: 2, phase: PlayViewerPhase.Playing }), {
      ...shown,
      phase: PlayViewerPhase.Playing,
    });
  });

  it("keeps the header as main last drew it, and counts each ask to give it the keyboard", () => {
    const bar = {
      liked: false,
      likes: 3,
      remixable: true,
      note: null,
      guestCard: false,
      facts: null,
      mic: null,
      title: "A",
      multiplayer: false,
      shown: true,
      comments: null,
      signedIn: true,
      remixing: false,
      nativeApp: null,
      purchase: null,
    };
    const drawn = viewerAfter(fresh, { slug: "a", openId: 2, phase: PlayViewerPhase.Loading, bar });
    assert.deepEqual(drawn?.bar, bar);
    const liked = { ...bar, liked: true, likes: 4 };
    assert.deepEqual(
      viewerAfter(drawn, { slug: "a", openId: 2, phase: PlayViewerPhase.Loading, bar: liked })?.bar,
      liked,
    );
    const playing = viewerAfter(drawn, { slug: "a", openId: 2, phase: PlayViewerPhase.Playing });
    assert.deepEqual(playing?.bar, bar, "news without a header leaves it as it was");
    assert.equal(playing?.phase, PlayViewerPhase.Playing);
    const asked = viewerAfter(playing, { slug: "a", openId: 2, phase: PlayViewerPhase.Playing, focusBar: true });
    assert.equal(asked?.focusAsks, 1);
    const again = viewerAfter(asked, { slug: "a", openId: 2, phase: PlayViewerPhase.Playing, focusBar: true });
    assert.equal(again?.focusAsks, 2);
  });

  it("ignores news of an earlier opening of the same game", () => {
    assert.equal(viewerAfter(shown, { slug: "a", openId: 1, phase: PlayViewerPhase.Closed }), shown);
    assert.equal(viewerAfter(shown, { slug: "a", openId: 1, phase: PlayViewerPhase.Failed }), shown);
  });

  it("lets the window's drag regions go while a game is open, its bar's layer over them", () => {
    assert.equal(nativeViewsUp(null), false);
    assert.equal(nativeViewsUp(shown), true, "loading: the bar's layer lies over the cover");
    assert.equal(nativeViewsUp({ ...shown, phase: PlayViewerPhase.Playing }), true);
    assert.equal(nativeViewsUp({ ...shown, phase: PlayViewerPhase.Failed }), true, "the bar stays over the failure");
  });

  it("leaves on Esc only while the cover or the failure is up, never under a game being played", () => {
    assert.equal(escapeLeaves(null), false);
    assert.equal(escapeLeaves(shown), true, "loading: nothing to lose yet");
    assert.equal(escapeLeaves({ ...shown, phase: PlayViewerPhase.Failed }), true);
    assert.equal(escapeLeaves({ ...shown, phase: PlayViewerPhase.Playing }), false, "a tap of Esc is the game's");
  });
  it("keeps a cover opened again (Try again) through the closing of the game it replaces", () => {
    // Main closes the failed opening, then opens the game afresh.
    const kept = viewerAfter(fresh, { slug: "a", openId: 1, phase: PlayViewerPhase.Closed });
    assert.equal(kept, fresh);
    const named = viewerAfter(kept, { slug: "a", openId: 2, phase: PlayViewerPhase.Loading });
    assert.deepEqual(named, { ...fresh, openId: 2 });
    const failed = viewerAfter(named, { slug: "a", openId: 2, phase: PlayViewerPhase.Failed });
    assert.equal(failed?.phase, PlayViewerPhase.Failed);
    assert.equal(viewerAfter(failed, { slug: "a", openId: 2, phase: PlayViewerPhase.Closed }), null);
  });
});

describe("Play's loader and header", () => {
  it("brings the loading cover's dither up out of black, never back, and holds", () => {
    const times = [0, 200, 600, 1200, DEVELOP_DONE_MS, 60_000];
    const shares = times.map(revealAt);
    assert.equal(shares[0], 0, "starts black");
    for (let i = 1; i < shares.length; i++) assert.ok((shares[i] ?? 0) >= (shares[i - 1] ?? 0), "never goes back");
    assert.equal(revealAt(DEVELOP_DONE_MS), 1, "all there once done");
    assert.equal(revealAt(60_000), 1, "holds once done");
    assert.equal(revealAt(-5), 0);
  });

  it("draws the cover as a colour ordered dither whose cells come out of black, the bright ones first, with no blue", () => {
    const size = 16;
    const half = size / 2;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) pixels.fill(i % size < half ? 230 : 70, i * 4, i * 4 + 3);
    const source = ditherSource(pixels, size, size);
    const out = new Uint8ClampedArray(size * size * 4);
    const cell = (i: number) => out.slice(i * 4, i * 4 + 3).join();
    const black = () => {
      drawDevelop(source, 0, out);
      return cell(0);
    };
    const dark = black();
    const shownIn = (left: boolean) =>
      Array.from({ length: size * size }, (_, i) => i).filter((i) => i % size < half === left && cell(i) !== dark)
        .length;

    drawDevelop(source, 0, out);
    assert.equal(new Set(Array.from({ length: size * size }, (_, i) => cell(i))).size, 1, "black everywhere");

    const steps = new Set([0, 85, 170, 255]);
    const stepped = (i: number) => [0, 1, 2].every((channel) => steps.has(out[i * 4 + channel] ?? -1));
    drawDevelop(source, 500, out);
    assert.ok(shownIn(true) > shownIn(false), "the bright half comes up first");
    assert.ok(shownIn(true) < (size * size) / 2, "partway: some cells still black");
    assert.ok(
      Array.from({ length: size * size }, (_, i) => i).every((i) => cell(i) === dark || stepped(i)),
      "what is up is already the cover's colour dither: no blue first",
    );

    drawDevelop(source, DEVELOP_DONE_MS, out);
    assert.ok(Array.from({ length: size * size }, (_, i) => i).every(stepped), "every channel on one of four steps");
    assert.equal(BAYER_8.length, 64);
  });

  it("speaks a header note on the button it is about (a microphone's on the mic switch), and marks only a copied link as done", () => {
    const bar = {
      liked: false,
      likes: 3,
      remixable: true,
      note: null,
      guestCard: false,
      facts: null,
      mic: null,
      title: "A",
      multiplayer: false,
      shown: true,
      comments: null,
      signedIn: true,
      remixing: false,
      nativeApp: null,
      purchase: null,
    };
    assert.equal(noteOn(undefined, PlayControl.Share), null);
    assert.equal(noteOn(bar, PlayControl.Share), null);
    assert.deepEqual(noteOn({ ...bar, note: PlayNote.Copied }, PlayControl.Share), {
      note: PlayNote.Copied,
      look: NoteLook.Done,
    });
    assert.equal(noteOn({ ...bar, note: PlayNote.Copied }, PlayControl.Invite), null, "not on another button");
    assert.equal(noteOn({ ...bar, note: PlayNote.InviteCopied }, PlayControl.Invite)?.look, NoteLook.Done);
    assert.equal(noteOn({ ...bar, note: PlayNote.SignIn }, PlayControl.Like)?.look, NoteLook.Said);
    assert.equal(noteOn({ ...bar, note: PlayNote.LikeFailed }, PlayControl.Like)?.look, NoteLook.Said);
    for (const note of [PlayNote.MicBlocked, PlayNote.MicMissing, PlayNote.MicFailed]) {
      assert.deepEqual(noteOn({ ...bar, note }, PlayControl.Mic), { note, look: NoteLook.Said }, note);
      assert.equal(noteOn({ ...bar, note }, PlayControl.MicDevices), null, "worn by the switch, not its menu");
    }
  });

  it("celebrates a like only when the player's own like turns it on, not when a game opens liked", () => {
    const bar = {
      liked: false,
      likes: 3,
      remixable: true,
      note: null,
      guestCard: false,
      facts: null,
      mic: null,
      title: "A",
      multiplayer: false,
      shown: true,
      comments: null,
      signedIn: true,
      remixing: false,
      nativeApp: null,
      purchase: null,
    };
    const liked = { ...bar, liked: true, likes: 4 };
    assert.equal(justLiked(bar, liked), true);
    assert.equal(justLiked(undefined, liked), false, "the first header drawn is how the game opened");
    assert.equal(justLiked(liked, liked), false);
    assert.equal(justLiked(liked, bar), false, "unliking is quiet");
    assert.equal(justLiked(bar, undefined), false);
  });
});

describe("Play's dashboard bar", () => {
  const BAR = 56;
  it("stays while the cards are near the top, hides as they scroll on down and comes back as soon as they scroll up", () => {
    const down = barAfterScroll(BAR_AT_TOP, 40, BAR);
    assert.equal(down.hidden, false, "near the top it stays");
    const hidden = barAfterScroll(down, 300, BAR);
    assert.equal(hidden.hidden, true);
    assert.equal(barAfterScroll(hidden, 600, BAR).hidden, true);
    const back = barAfterScroll(hidden, 280, BAR);
    assert.equal(back.hidden, false, "any scroll up brings it back");
    assert.equal(barAfterScroll(back, 0, BAR).hidden, false);
  });

  it("does not flicker on a move of a pixel or two", () => {
    const hidden = barAfterScroll(barAfterScroll(BAR_AT_TOP, 100, BAR), 400, BAR);
    assert.equal(barAfterScroll(hidden, 398, BAR), hidden, "the same state: nothing to draw");
    const shown = barAfterScroll(hidden, 300, BAR);
    assert.equal(barAfterScroll(shown, 302, BAR), shown);
  });
});

describe("Play state actions", () => {
  it("says an empty tab is loading, keeps a tab with games as it is, and marks a further page as coming", () => {
    const empty = initialPlay();
    assert.equal(
      feedOf(feedRequested(empty, PlayCategory.Racing, false), PlayCategory.Racing).status,
      FeedStatus.Loading,
    );
    const loaded = {
      ...empty,
      feeds: { [PlayCategory.Racing]: withPage(EMPTY_FEED, page([game("a")], "n2"), false, 1) },
    };
    assert.equal(feedRequested(loaded, PlayCategory.Racing, false), loaded);
    assert.equal(feedOf(feedRequested(loaded, PlayCategory.Racing, true), PlayCategory.Racing).loadingMore, true);
  });

  it("marks an empty tab failed, and keeps a tab with games when a read fails, saying a further page failed", () => {
    const failed = feedFailed(initialPlay(), PlayCategory.Arcade, false);
    assert.equal(feedOf(failed, PlayCategory.Arcade).status, FeedStatus.Failed);
    const loaded = withPage(EMPTY_FEED, page([game("a")], "n2"), false, 1);
    const state = { ...initialPlay(), feeds: { [PlayCategory.Arcade]: { ...loaded, loadingMore: true } } };
    const kept = feedOf(feedFailed(state, PlayCategory.Arcade, true), PlayCategory.Arcade);
    assert.deepEqual(kept, { ...loaded, moreFailed: true });
    const refreshed = feedOf(
      feedFailed({ ...state, feeds: { [PlayCategory.Arcade]: loaded } }, PlayCategory.Arcade, false),
      PlayCategory.Arcade,
    );
    assert.deepEqual(refreshed, loaded, "a first page read again behind the cards fails quietly");
  });

  it("keeps the state object when a count changes nothing", () => {
    const loaded = withPage(EMPTY_FEED, page([game("duo", { multiplayer: true, online: 2 })]), false, 1);
    const state = { ...initialPlay(), feeds: { [PlayCategory.Multiplayer]: loaded } };
    assert.equal(onlineCounted(state, PlayCategory.Multiplayer, { duo: 2 }), state);
    const counted = onlineCounted(state, PlayCategory.Multiplayer, { duo: 5 });
    assert.equal(feedOf(counted, PlayCategory.Multiplayer).games[0]?.online, 5);
  });

  it("starts on Games with each shelf's first tab, and keeps them when the shelves read without tabs", () => {
    const state = initialPlay();
    assert.equal(state.shelf, PlayShelf.Games);
    assert.deepEqual(state.categories, UNCOUNTED.categories);
    assert.deepEqual(state.counts, UNCOUNTED.counts);
    assert.equal(shelvesLoaded(state, { ...UNCOUNTED, categories: [] }), state);
    const counted = { games: 59, tools: 16, assets: 44 };
    const read = shelvesLoaded(state, { counts: counted, categories: [PlayCategory.Featured, PlayCategory.Racing] });
    assert.deepEqual(read.categories, [PlayCategory.Featured, PlayCategory.Racing]);
    assert.deepEqual(read.counts, counted);
  });

  it("turns to another shelf, and keeps the state when it is already on it", () => {
    const state = initialPlay();
    assert.equal(shelfChosen(state, PlayShelf.Games), state);
    assert.equal(shelfChosen(state, PlayShelf.Tools).shelf, PlayShelf.Tools);
  });

  it("lists a shelf's tabs from the ones shown, in order, and its first tab when none of its are", () => {
    const shown = [
      PlayCategory.Featured,
      PlayCategory.Arcade,
      PlayCategory.Tools,
      PlayCategory.Vfx,
      PlayCategory.Assets,
    ];
    assert.deepEqual(shelfTabs(shown, PlayShelf.Games), [PlayCategory.Featured, PlayCategory.Arcade]);
    assert.deepEqual(shelfTabs(shown, PlayShelf.Tools), [PlayCategory.Tools, PlayCategory.Vfx]);
    assert.deepEqual(shelfTabs(shown, PlayShelf.Assets), [PlayCategory.Assets]);
    assert.deepEqual(shelfTabs([], PlayShelf.Tools), [PlayCategory.Tools]);
  });

  it("holds a finished remix for the shell until it is opened", () => {
    const remixed = { ...initialPlay(), remixed: "a-copy" };
    const closed = viewerReported(remixed, { slug: "a", openId: 1, phase: PlayViewerPhase.Closed });
    assert.equal(closed.remixed, "a-copy", "the viewer's news keeps the one waiting");
    const done = remixOpened(remixed);
    assert.equal(done.remixed, null);
    assert.equal(remixOpened(done), done, "nothing waiting: the same state");
  });

  it("holds the guest card's Sign in until the shell has run it, once", () => {
    const opened = gameOpened(initialPlay(), entry("a"));
    const named = viewerReported(opened, { slug: "a", openId: 1, phase: PlayViewerPhase.Playing });
    assert.equal(named.installAsked, false);
    const asked = viewerReported(named, { slug: "a", openId: 1, phase: PlayViewerPhase.Closed, install: true });
    assert.equal(asked.viewer, null);
    assert.equal(asked.installAsked, true);
    const answered = installAnswered(asked);
    assert.equal(answered.installAsked, false);
    assert.equal(installAnswered(answered), answered, "nothing waiting: the same state");
    const later = viewerReported(answered, { slug: "a", openId: 1, phase: PlayViewerPhase.Closed });
    assert.equal(later.installAsked, false, "a later closing asks nothing again");
  });

  it("makes a copy only for the viewer shown closing for its bar's Remix", () => {
    const opened = gameOpened(initialPlay(), entry("a"));
    const shown = viewerReported(opened, { slug: "a", openId: 1, phase: PlayViewerPhase.Playing }).viewer;
    const closing = { slug: "a", openId: 1, phase: PlayViewerPhase.Closed };
    assert.equal(remixClosed(shown, { ...closing, remix: true }), true);
    assert.equal(remixClosed(shown, closing), false, "a plain closing");
    assert.equal(remixClosed(shown, { ...closing, openId: 2, remix: true }), false, "another opening");
    assert.equal(remixClosed(shown, { ...closing, slug: "b", remix: true }), false, "another game");
    assert.equal(remixClosed(null, { ...closing, remix: true }), false, "nothing shown");
  });

  it("shows the maker's profile when their name closed the viewer, and only for the viewer shown", () => {
    const opened = gameOpened(initialPlay(), entry("a"));
    const named = viewerReported(opened, { slug: "a", openId: 1, phase: PlayViewerPhase.Playing });
    const closed = viewerReported(named, { slug: "a", openId: 1, phase: PlayViewerPhase.Closed, profile: "u-maker" });
    assert.equal(closed.viewer, null);
    assert.deepEqual(closed.view, { page: PlayPage.Profile, userId: "u-maker", from: PlayPage.Shelf });
    const again = viewerReported(closed, { slug: "a", openId: 1, phase: PlayViewerPhase.Closed, profile: "u-other" });
    assert.equal(again, closed, "a viewer already gone shows nobody");
  });

  it("holds a remix's failure until the shell has told it", () => {
    const failed = { ...initialPlay(), remixFailed: true };
    const told = remixFailureTold(failed);
    assert.equal(told.remixFailed, false);
    assert.equal(remixFailureTold(told), told);
  });
});

describe("Play: a remix shown in Create while it is made", () => {
  const progress = (
    slug: string,
    step: RemixStep,
    done: number | null = null,
    total: number | null = null,
    name: string | null = null,
  ) => ({ slug, step, done, total, name });

  it("starts at its first step, follows main's steps for its own game only, and ends once", () => {
    const started = remixStarted(initialPlay(), { slug: "a", title: "A", coverUrl: "https://c/a.webp" });
    assert.deepEqual(started.making, {
      slug: "a",
      title: "A",
      coverUrl: "https://c/a.webp",
      step: RemixStep.Copy,
      done: null,
      total: null,
      name: null,
      view: RemixView.Shown,
    });
    assert.equal(remixStarted(started, entry("b")), started, "one remix at a time");
    const models = remixProgressed(started, progress("a", RemixStep.Models, 10, 52));
    assert.deepEqual([models.making?.step, models.making?.done, models.making?.total], [RemixStep.Models, 10, 52]);
    assert.equal(remixProgressed(models, progress("b", RemixStep.Build)), models, "another game's news");
    assert.equal(remixProgressed(models, progress("a", RemixStep.Models, 10, 52)), models, "nothing new");
    const ended = remixEnded(models);
    assert.equal(ended.making, null);
    assert.equal(remixProgressed(ended, progress("a", RemixStep.Build)), ended, "news after the end starts nothing");
    assert.equal(remixEnded(ended), ended);
  });

  it("keeps the new game's name from the step that adopted it, and lists the game once beside it", () => {
    const started = remixStarted(initialPlay(), entry("a"));
    const adopted = remixProgressed(started, progress("a", RemixStep.Build, null, null, "a-remix"));
    assert.equal(adopted.making?.name, "a-remix");
    const games = [{ name: "a-remix" }, { name: "other" }];
    assert.deepEqual(
      besideRemix(games, adopted.making?.name ?? null).map((game) => game.name),
      ["other"],
    );
    assert.equal(besideRemix(games, null), games, "no remix: every game");
    assert.equal(besideRemix(games, started.making?.name ?? null), games, "not adopted yet: every game");
  });

  it("ends with the told failure of a remix", () => {
    const started = remixStarted(initialPlay(), entry("a"));
    const told = remixFailureTold({ ...started, remixFailed: true });
    assert.equal(told.making, null);
    assert.equal(told.remixFailed, false);
  });

  it("makes a card's remix from the press: shown at once, then its name or its failure waits for the shell", async () => {
    const answer = deferred<string>();
    const { api, calls } = fakeApi({ playRemix: () => answer.promise });
    const store = createPlayStore(api, memory(), manualClock().now);
    const made = store.remix(game("a", { remixable: true }));
    assert.equal(store.getState().making?.slug, "a", "shown before main has answered");
    void store.remix(game("b", { remixable: true }));
    assert.deepEqual(calls.remix, ["a"], "a second press waits for the first remix");
    answer.resolve("a-remix");
    await made;
    assert.equal(store.getState().remixed, "a-remix");
    assert.equal(store.getState().making?.slug, "a", "still shown until the shell opens it");

    const refused = createPlayStore(fakeApi({ playRemix: () => Promise.reject(new Error("no")) }).api, memory());
    await refused.remix(game("c", { remixable: true }));
    assert.equal(refused.getState().remixFailed, true);
  });

  it("makes the viewer's remix as a card's: the viewer gives way, and main always answers", async () => {
    const { api, calls } = fakeApi();
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.open(entry("a"));
    await store.remixViewed();
    assert.equal(calls.close, 1, "the viewer gives way at once");
    assert.deepEqual(calls.remix, ["a"]);
    assert.equal(store.getState().remixed, "a-copy");
    assert.equal(store.getState().making?.slug, "a", "still shown until the shell opens it");

    // A remix main refuses still ends: nothing stays on screen waiting for news that never comes.
    const refused = createPlayStore(fakeApi({ playRemix: () => Promise.reject(new Error("no")) }).api, memory());
    await refused.open(entry("b"));
    await refused.remixViewed();
    assert.equal(refused.getState().remixFailed, true);
  });
});

describe("Play: a remix set aside while the person is elsewhere", () => {
  it("goes aside when the person goes elsewhere, comes back from its row, and stays while its game opens", () => {
    const started = remixStarted(initialPlay(), entry("a"));
    assert.equal(remixCovers(started.making), true);
    const aside = remixSetAside(started);
    assert.equal(aside.making?.view, RemixView.Aside);
    assert.equal(remixCovers(aside.making), false, "what the person went to is on screen");
    assert.equal(remixSetAside(aside), aside);
    const back = remixReturnedTo(aside);
    assert.equal(remixCovers(back.making), true);
    assert.equal(remixReturnedTo(back), back);
    // The shell's own opening of the new game is a navigation too: it never sets the remix aside.
    const opening = remixOpened({ ...back, remixed: "a-remix" });
    assert.equal(opening.making?.view, RemixView.Opening);
    assert.equal(remixSetAside(opening), opening);
    assert.equal(remixCovers(opening.making), true, "on screen until its game is open under it");
    assert.equal(remixSetAside(initialPlay()).making, null, "no remix: nothing to set aside");
  });

  it("opens the finished game for a person still with it, and only for them", () => {
    const shown = remixStarted(initialPlay(), entry("a")).making;
    assert.equal(stillWithRemix(shown, false), true);
    assert.equal(stillWithRemix(shown, true), false, "Play or Plugins over Create: they stay there");
    assert.equal(stillWithRemix(remixSetAside(remixStarted(initialPlay(), entry("a"))).making, false), false);
    assert.equal(stillWithRemix(null, false), false);
  });
});

describe("Play: how a remix being made reads", () => {
  const MB = 1024 * 1024;
  const making = (step: RemixStep, done: number | null = null, total: number | null = null): RemixUnderway => ({
    slug: "a",
    title: "A",
    coverUrl: null,
    step,
    done,
    total,
    name: null,
    view: RemixView.Shown,
  });

  it("says the step it is on, the models with their megabytes", () => {
    assert.equal(remixLine(making(RemixStep.Copy)), "Copying files");
    assert.equal(remixLine(making(RemixStep.Models, 31 * MB, 52 * MB)), "Downloading models · 31 of 52 MB");
    assert.equal(remixLine(making(RemixStep.Models, 4 * MB, null)), "Downloading models · 4 MB");
    assert.equal(remixLine(making(RemixStep.Models)), "Downloading models");
    assert.equal(remixLine(making(RemixStep.Models, 0, 0)), "Downloading models · 0 MB", "no total to count to");
    assert.equal(remixLine(making(RemixStep.Packages)), "Installing packages");
    assert.equal(remixLine(making(RemixStep.Build)), "Building the game");
  });

  it("draws the steps before its own done, its own under way, the rest to come", () => {
    assert.deepEqual(
      remixSegments(making(RemixStep.Packages)).map((step) => [step.label, step.state]),
      [
        ["Files", StepState.Done],
        ["Models", StepState.Done],
        ["Packages", StepState.Current],
        ["Build", StepState.Next],
      ],
    );
  });

  it("goes round its ring only forward, the models by their bytes", () => {
    const shares = [
      remixShare(making(RemixStep.Copy)),
      remixShare(making(RemixStep.Models, 0, 52 * MB)),
      remixShare(making(RemixStep.Models, 26 * MB, 52 * MB)),
      remixShare(making(RemixStep.Models, 52 * MB, 52 * MB)),
      remixShare(making(RemixStep.Packages)),
      remixShare(making(RemixStep.Build)),
    ];
    for (const [i, share] of shares.entries()) assert.ok(i === 0 || share >= (shares[i - 1] ?? 1), `${shares}`);
    const [first = 0, last = 1] = [shares[0], shares.at(-1)];
    assert.ok(first > 0 && last < 1, "under way, never empty, never full");
  });

  it("keeps the new game's name once the shell opens it, so its own row takes over", () => {
    const started = remixStarted(initialPlay(), entry("a"));
    const opened = remixOpened({ ...started, remixed: "a-remix" });
    assert.equal(opened.remixed, null);
    assert.equal(opened.making?.name, "a-remix");
  });
});

describe("Play store: an opening main refused", () => {
  it("closes from Back even though main never answered it", async () => {
    const { api } = fakeApi({ playOpen: () => Promise.reject(new Error("no view")) });
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.open(game("a"));
    assert.equal(store.getState().viewer?.phase, PlayViewerPhase.Failed);
    await store.close();
    assert.equal(store.getState().viewer, null, "nothing in main to close: the cover goes here");
  });
});

describe("Play store: reading tabs", () => {
  it("reads a tab once while its first page is on its way", async () => {
    const pending = deferred<PlayFeedPage>();
    const { api, calls } = fakeApi({ playFeed: () => pending.promise });
    const store = createPlayStore(api, memory(), manualClock().now);
    const first = store.loadFeed(PlayCategory.Featured);
    const second = store.loadFeed(PlayCategory.Featured);
    assert.equal(calls.feed.length, 1);
    assert.deepEqual(calls.feed[0], { category: PlayCategory.Featured, cursor: null });
    assert.equal(feedOf(store.getState(), PlayCategory.Featured).status, FeedStatus.Loading);
    pending.resolve(page([game("a")]));
    await Promise.all([first, second]);
    assert.deepEqual(slugsOf(feedOf(store.getState(), PlayCategory.Featured).games), ["a"]);
    assert.equal(feedOf(store.getState(), PlayCategory.Featured).status, FeedStatus.Ready);
  });

  it(`reads a tab again only once it is ${FEED_STALE_MS} ms old, showing its games meanwhile`, async () => {
    const clock = manualClock();
    const answers = [page([game("a")]), page([game("b")])];
    const second = deferred<PlayFeedPage>();
    const { api, calls } = fakeApi({
      playFeed: () => (calls.feed.length === 1 ? Promise.resolve(answers[0] ?? page([])) : second.promise),
    });
    const store = createPlayStore(api, memory(), clock.now);
    await store.loadFeed(PlayCategory.Racing);
    clock.advance(FEED_STALE_MS - 1);
    await store.loadFeed(PlayCategory.Racing);
    assert.equal(calls.feed.length, 1, "a fresh tab is not read again");
    clock.advance(1);
    const reread = store.loadFeed(PlayCategory.Racing);
    assert.equal(calls.feed.length, 2, "a stale tab is read again");
    const meanwhile = feedOf(store.getState(), PlayCategory.Racing);
    assert.deepEqual(slugsOf(meanwhile.games), ["a"]);
    assert.equal(meanwhile.status, FeedStatus.Ready);
    second.resolve(answers[1] ?? page([]));
    await reread;
    assert.deepEqual(slugsOf(feedOf(store.getState(), PlayCategory.Racing).games), ["b"]);
  });

  it("reads a fresh tab again when forced", async () => {
    const { api, calls } = fakeApi({ playFeed: () => Promise.resolve(page([game("a")])) });
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.loadFeed(PlayCategory.Featured);
    await store.loadFeed(PlayCategory.Featured, { force: true });
    assert.equal(calls.feed.length, 2);
  });

  it("marks an empty tab failed when its read fails, and keeps a tab's games when a later read fails", async () => {
    const clock = manualClock();
    let fail = true;
    const { api } = fakeApi({
      playFeed: () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve(page([game("a")]))),
    });
    const store = createPlayStore(api, memory(), clock.now);
    await store.loadFeed(PlayCategory.Shooter);
    assert.equal(feedOf(store.getState(), PlayCategory.Shooter).status, FeedStatus.Failed);
    fail = false;
    await store.loadFeed(PlayCategory.Shooter);
    fail = true;
    clock.advance(FEED_STALE_MS);
    await store.loadFeed(PlayCategory.Shooter);
    const kept = feedOf(store.getState(), PlayCategory.Shooter);
    assert.deepEqual(slugsOf(kept.games), ["a"]);
    assert.equal(kept.status, FeedStatus.Ready);
  });
});

describe("Play store: further pages", () => {
  it("reads a further page from the tab's cursor, and nothing once the tab has no cursor", async () => {
    const pages: Record<string, PlayFeedPage> = {
      first: page([game("a"), game("b")], "cursor-2"),
      "cursor-2": page([game("b"), game("c")], null),
    };
    const { api, calls } = fakeApi({
      playFeed: (request) => Promise.resolve(pages[request.cursor ?? "first"] ?? page([])),
    });
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.loadFeed(PlayCategory.Sports, { more: true });
    assert.equal(calls.feed.length, 0, "no first page yet: no further page either");
    await store.loadFeed(PlayCategory.Sports);
    await store.loadFeed(PlayCategory.Sports, { more: true });
    assert.deepEqual(calls.feed[1], { category: PlayCategory.Sports, cursor: "cursor-2" });
    assert.deepEqual(slugsOf(feedOf(store.getState(), PlayCategory.Sports).games), ["a", "b", "c"]);
    await store.loadFeed(PlayCategory.Sports, { more: true });
    assert.equal(calls.feed.length, 2, "the end of the tab is not read again");
  });

  it("asks for a further page once while one is on its way", async () => {
    const more = deferred<PlayFeedPage>();
    const { api, calls } = fakeApi({
      playFeed: (request) => (request.cursor ? more.promise : Promise.resolve(page([game("a")], "cursor-2"))),
    });
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.loadFeed(PlayCategory.Sports);
    const first = store.loadFeed(PlayCategory.Sports, { more: true });
    const second = store.loadFeed(PlayCategory.Sports, { more: true });
    assert.equal(calls.feed.length, 2);
    assert.equal(feedOf(store.getState(), PlayCategory.Sports).loadingMore, true);
    more.resolve(page([game("b")], null));
    await Promise.all([first, second]);
    assert.equal(feedOf(store.getState(), PlayCategory.Sports).loadingMore, false);
  });
});

describe("Play store: a further page that fails", () => {
  it("says so under the grid, keeps the games, and clears it when the page is asked again", async () => {
    let fail = true;
    const { api } = fakeApi({
      playFeed: (request) => {
        if (!request.cursor) return Promise.resolve(page([game("a")], "cursor-2"));
        return fail ? Promise.reject(new Error("offline")) : Promise.resolve(page([game("b")], null));
      },
    });
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.loadFeed(PlayCategory.Sports);
    assert.equal(feedOf(store.getState(), PlayCategory.Sports).moreFailed, false);
    await store.loadFeed(PlayCategory.Sports, { more: true });
    const failed = feedOf(store.getState(), PlayCategory.Sports);
    assert.equal(failed.moreFailed, true);
    assert.deepEqual(slugsOf(failed.games), ["a"]);
    assert.equal(failed.nextCursor, "cursor-2", "the cursor stays for the next try");
    fail = false;
    await store.loadFeed(PlayCategory.Sports, { more: true });
    const after = feedOf(store.getState(), PlayCategory.Sports);
    assert.equal(after.moreFailed, false);
    assert.deepEqual(slugsOf(after.games), ["a", "b"]);
  });
});

describe("Play store: counting, opening and tabs", () => {
  it("counts players only in a tab's multiplayer games, and asks nothing for a tab without any", async () => {
    const tabs: Partial<Record<PlayCategory, PlayFeedPage>> = {
      [PlayCategory.Multiplayer]: page([game("solo"), game("duo", { multiplayer: true })]),
      [PlayCategory.Arcade]: page([game("solo")]),
    };
    const { api, calls } = fakeApi({
      playFeed: (request) => Promise.resolve(tabs[request.category] ?? page([])),
      playOnline: () => Promise.resolve({ duo: 5, solo: 9 }),
    });
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.loadFeed(PlayCategory.Multiplayer);
    await store.loadFeed(PlayCategory.Arcade);
    await store.countOnline(PlayCategory.Multiplayer);
    assert.deepEqual(calls.online, [["duo"]]);
    const games = feedOf(store.getState(), PlayCategory.Multiplayer).games;
    assert.deepEqual(
      games.map((item) => item.online),
      [null, 5],
    );
    await store.countOnline(PlayCategory.Arcade);
    await store.countOnline(PlayCategory.Fighting);
    assert.equal(calls.online.length, 1);
  });

  it("keeps the last counts when counting fails", async () => {
    const { api } = fakeApi({
      playFeed: () => Promise.resolve(page([game("duo", { multiplayer: true, online: 2 })])),
      playOnline: () => Promise.reject(new Error("offline")),
    });
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.loadFeed(PlayCategory.Multiplayer);
    await store.countOnline(PlayCategory.Multiplayer);
    assert.equal(feedOf(store.getState(), PlayCategory.Multiplayer).games[0]?.online, 2);
  });

  it("opens a game with its cover loading, first in Recent and remembered in storage", async () => {
    const storage = memory({ [STORAGE_KEYS.playRecent]: JSON.stringify([entry("x")]) });
    const { api, calls } = fakeApi();
    const store = createPlayStore(api, storage, manualClock().now);
    assert.deepEqual(slugsOf(store.getState().recent), ["x"], "Recent starts from storage");
    await store.open(entry("y"));
    assert.deepEqual(calls.open, ["y"]);
    assert.deepEqual(store.getState().viewer, { ...entry("y"), phase: PlayViewerPhase.Loading, openId: null });
    assert.deepEqual(slugsOf(store.getState().recent), ["y", "x"]);
    assert.deepEqual(slugsOf(readRecent(storage)), ["y", "x"]);
    assert.deepEqual(slugsOf(createPlayStore(api, storage).getState().recent), ["y", "x"], "a new window remembers it");
  });

  it("marks the viewer failed when main refuses to open the game, and opens it again on retry", async () => {
    let refuse = true;
    const { api, calls } = fakeApi({
      playOpen: () => (refuse ? Promise.reject(new Error("no view")) : Promise.resolve()),
    });
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.open(entry("y"));
    assert.equal(store.getState().viewer?.phase, PlayViewerPhase.Failed);
    refuse = false;
    await store.retry();
    assert.deepEqual(calls.open, ["y", "y"]);
    assert.equal(store.getState().viewer?.phase, PlayViewerPhase.Loading);
  });

  it("leaves the shown game alone when main refuses one opened before it", async () => {
    const refusal = deferred<void>();
    const { api } = fakeApi({ playOpen: (slug) => (slug === "a" ? refusal.promise : Promise.resolve()) });
    const store = createPlayStore(api, memory(), manualClock().now);
    const openedFirst = store.open(entry("a"));
    await store.open(entry("b"));
    refusal.reject(new Error("no view"));
    await openedFirst;
    assert.deepEqual(store.getState().viewer, { ...entry("b"), phase: PlayViewerPhase.Loading, openId: null });
    assert.deepEqual(slugsOf(store.getState().recent), ["b", "a"]);
  });

  it("retries nothing while no game is shown", async () => {
    const { api, calls } = fakeApi();
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.retry();
    assert.deepEqual(calls.open, []);
  });

  it("keeps each shelf's first tab when the shelves cannot be read, and takes them when they can", async () => {
    const refused = createPlayStore(fakeApi({ playShelves: () => Promise.reject(new Error("offline")) }).api, memory());
    await refused.loadShelves();
    assert.deepEqual(refused.getState().categories, UNCOUNTED.categories);
    const shelves = {
      counts: { games: 59, tools: 16, assets: 44 },
      categories: [PlayCategory.Featured, PlayCategory.Racing],
    };
    const read = createPlayStore(fakeApi({ playShelves: () => Promise.resolve(shelves) }).api, memory());
    await read.loadShelves();
    assert.deepEqual(read.getState().categories, shelves.categories);
    assert.deepEqual(read.getState().counts, shelves.counts);
    read.chooseShelf(PlayShelf.Assets);
    assert.equal(read.getState().shelf, PlayShelf.Assets);
  });
});

describe("the sidebar's account plate", () => {
  const who = {
    id: "u1",
    name: "Rab Neba",
    handle: null,
    imageUrl: null,
    avatarVariant: 0,
    pro: true,
    joinedAt: null,
    avatarStyle: null,
    photoUrl: null,
    avatarVariantKept: true,
    handleChosen: null,
  };
  const shown = (people: Partial<Parameters<typeof plateState>[0]>, online = true) =>
    plateState({ me: null, account: null, ...people }, online);

  it("says nothing until it knows the account, unless one is remembered", () => {
    assert.equal(shown({}), PlateState.Hidden);
    assert.equal(shown({ me: who }), PlateState.SignedIn);
    assert.equal(shown({ me: who }, false), PlateState.Offline);
  });

  it("is always there signed out, signing in, or once a sign-in ended", () => {
    assert.equal(shown({ account: GenexAccountStatus.SignedOut }), PlateState.SignedOut);
    assert.equal(shown({ account: GenexAccountStatus.SigningIn }), PlateState.SigningIn);
    assert.equal(shown({ account: GenexAccountStatus.Ended }), PlateState.Ended);
  });

  it("shows the account signed in, and as last time while offline: offline is never signed out", () => {
    assert.equal(shown({ account: GenexAccountStatus.SignedIn, me: who }), PlateState.SignedIn);
    assert.equal(shown({ account: GenexAccountStatus.SignedIn, me: who }, false), PlateState.Offline);
    assert.equal(shown({ account: GenexAccountStatus.SignedIn }), PlateState.Hidden, "signed in, not read yet");
  });
});

describe("Play covers shown before", () => {
  const url = (n: number) => `https://cdn.genex.technology/covers/${n}.webp`;

  it("a cover starts shown only once the window has shown it", () => {
    const covers = createShownCovers(4);
    assert.equal(covers.has(url(1)), false);
    covers.add(url(1));
    assert.equal(covers.has(url(1)), true);
    assert.equal(covers.has(url(2)), false);
  });

  it("keeps only the most recently shown covers, a cover shown again counting as new", () => {
    const covers = createShownCovers(3);
    for (const n of [1, 2, 3]) covers.add(url(n));
    covers.add(url(1));
    covers.add(url(4));
    assert.deepEqual(
      [1, 2, 3, 4].map((n) => covers.has(url(n))),
      [true, false, true, true],
    );
  });
});

describe("Play store: a native game's own page", () => {
  const nativeOnly = (slug: string) => game(slug, { native: { web: false, engine: "unity", builds: [] } });
  const detail = (slug: string): PlayGameDetail => ({
    ...nativeOnly(slug),
    likes: 0,
    liked: false,
    comments: 0,
    shots: [],
    updatedAt: null,
  });

  it("opens a native-only game's page instead of the viewer, reads it, and remembers it in Recent as a page", async () => {
    const { api, calls } = fakeApi({ playGame: async (slug) => detail(slug) });
    const storage = memory();
    const store = createPlayStore(api, storage, manualClock().now);
    await store.open({ ...entry("dust-runners"), page: true });
    assert.deepEqual(calls.open, [], "no viewer");
    assert.deepEqual(store.getState().view, {
      page: PlayPage.Game,
      slug: "dust-runners",
      back: { page: PlayPage.Shelf },
    });
    await store.loadGame("dust-runners");
    assert.equal(store.getState().games["dust-runners"]?.game?.slug, "dust-runners");
    assert.deepEqual(calls.game.slice(0, 1), ["dust-runners"]);
    assert.equal(store.getState().recent[0]?.page, true);
    assert.equal(readRecent(storage)[0]?.page, true, "Recent remembers it opens a page");
    store.back();
    assert.deepEqual(store.getState().view, { page: PlayPage.Shelf });
  });

  it("knows a game opens its page from the cards it read, so Join and Recent find it too", async () => {
    const { api, calls } = fakeApi({
      playFeed: async () => page([nativeOnly("dust-runners"), game("lost-cathedral")]),
      playGame: async (slug) => detail(slug),
    });
    const store = createPlayStore(api, memory(), manualClock().now);
    await store.loadFeed(PlayCategory.Featured);
    await store.open(entry("dust-runners"));
    assert.equal(store.getState().view.page, PlayPage.Game);
    await store.open(entry("lost-cathedral"));
    assert.deepEqual(calls.open, ["lost-cathedral"], "a web game still plays in the viewer");
  });

  it("goes back from a profile opened on a game's page to that page, and from the page to where it came from", () => {
    const store = createPlayStore(fakeApi({ playGame: async (slug) => detail(slug) }).api, memory());
    store.showFriends();
    store.showGame("dust-runners");
    store.showProfile("u-kir");
    assert.equal(store.getState().view.page, PlayPage.Profile);
    store.back();
    assert.deepEqual(store.getState().view, {
      page: PlayPage.Game,
      slug: "dust-runners",
      back: { page: PlayPage.Friends },
    });
    store.back();
    assert.deepEqual(store.getState().view, { page: PlayPage.Friends });
  });

  it("asks main for every install and session action, and reads main's news into the store", async () => {
    const { api, calls } = fakeApi();
    const store = createPlayStore(api, memory());
    await store.install("dust-runners");
    await store.cancelInstall("dust-runners");
    await store.uninstall("dust-runners");
    await store.launch("dust-runners");
    await store.showWindow("dust-runners");
    await store.quitGame("dust-runners");
    assert.deepEqual(calls.install, ["dust-runners"]);
    assert.deepEqual(calls.cancel, ["dust-runners"]);
    assert.deepEqual(calls.uninstall, ["dust-runners"]);
    assert.deepEqual(calls.launch, ["dust-runners"]);
    assert.deepEqual(calls.session, [
      ["dust-runners", SessionAction.Show],
      ["dust-runners", SessionAction.Quit],
    ]);
    const installs = { ...NO_INSTALLS, progress: [] };
    store.setState((state) => installsReported(state, installs), true);
    assert.equal(store.getState().installs, installs);
    const sessions = [
      { slug: "dust-runners", phase: NativeSessionPhase.Running, startedAt: "2026-10-20T00:00:00.000Z", failure: null },
    ];
    store.setState((state) => sessionsReported(state, sessions), true);
    assert.equal(store.getState().sessions, sessions);
  });
});

describe("Play store: one copy of a game at a time", () => {
  it("brings a native app being played forward instead of opening its web build", async () => {
    const { api, calls } = fakeApi();
    const store = createPlayStore(api, memory());
    store.setState(
      (state) =>
        sessionsReported(state, [
          { slug: "skate", phase: NativeSessionPhase.Running, startedAt: "2026-10-20T00:00:00.000Z", failure: null },
        ]),
      true,
    );
    await store.open(entry("skate"));
    assert.deepEqual(calls.open, [], "no viewer");
    assert.deepEqual(calls.session, [["skate", SessionAction.Show]]);
    assert.equal(store.getState().viewer, null);
    store.setState(
      (state) =>
        sessionsReported(state, [
          { slug: "skate", phase: NativeSessionPhase.Failed, startedAt: "2026-10-20T00:00:00.000Z", failure: null },
        ]),
      true,
    );
    await store.open(entry("skate"));
    assert.deepEqual(calls.open, ["skate"], "a failed start is not a copy being played");
  });
});
