/**
 * A Play card's ⋯ menu on the renderer's side: what a change does to the cards on screen (tabs,
 * Recent, profiles), what the mobile row reads, and the store's `manage` over a fake API.
 */
import assert from "node:assert/strict";
import { NO_INSTALLS } from "../../src/shared/play-native.ts";
import { describe, it } from "node:test";
import { changedGame, curationOf, MobileShown, mobileShown } from "../../src/renderer/play/card-menu/manage-model.ts";
import { EMPTY_FEED, FeedStatus } from "../../src/renderer/play/play-model.ts";
import { initialPeople, LoadStatus, profileGameChanged } from "../../src/renderer/state/people.ts";
import { createPlayStore, gameChanged, initialPlay } from "../../src/renderer/state/play.ts";
import {
  type PlayChangeResult,
  PlayChangeKind,
  PlayChangeOutcome,
  type PlayCuration,
  type PlayGameChange,
  PlayMobileSupport,
} from "../../src/shared/play-manage.ts";
import { PlayCategory, type PlayFeedPage, type PlayGame } from "../../src/shared/play.ts";
import type { PlayProfile } from "../../src/shared/play-people.ts";

const CURATION: PlayCuration = { mobileSupport: null, mobileAuto: null, categories: ["arcade"], remixOff: false };

function game(slug: string, remixOff = false): PlayGame {
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
    author: { id: "owner", name: "Owner", imageUrl: null },
    remixable: !remixOff,
    assetKind: null,
    curation: { ...CURATION, remixOff },
  };
}

const DONE: PlayChangeResult = { outcome: PlayChangeOutcome.Done };
const ready = (games: PlayGame[]) => ({ ...EMPTY_FEED, games, status: FeedStatus.Ready, at: 1 });
const slugs = (games: readonly PlayGame[] | undefined) => games?.map((g) => g.slug);

describe("Play card menu: a change on the cards", () => {
  it("takes a game off every card once it is unpublished or deleted", () => {
    for (const kind of [PlayChangeKind.Unpublish, PlayChangeKind.Delete] as const)
      assert.equal(changedGame(game("skate"), { kind }, DONE), null);
  });

  it("hides Remix when remixing is turned off and leaves showing it again to the next read", () => {
    const off = changedGame(game("skate"), { kind: PlayChangeKind.Remixing, allowed: false }, DONE) as PlayGame;
    assert.equal(off.remixable, false);
    assert.equal(curationOf(off).remixOff, true);
    // Whether Remix shows again is the gallery's to say on the next read (a game for sale never offers it).
    const on = changedGame(off, { kind: PlayChangeKind.Remixing, allowed: true }, DONE) as PlayGame;
    assert.equal(on.remixable, false);
    assert.equal(curationOf(on).remixOff, false);
  });

  it("keeps genex.games' stored tags, the asked ones when it gives none, and sets the mobile flag", () => {
    const tags: PlayGameChange = { kind: PlayChangeKind.Tags, categories: ["sports"] };
    const stored = changedGame(game("skate"), tags, { ...DONE, categories: ["racing"] }) as PlayGame;
    assert.deepEqual(curationOf(stored).categories, ["racing"]);
    assert.deepEqual(curationOf(changedGame(game("skate"), tags, DONE) as PlayGame).categories, ["sports"]);
    const mobile = changedGame(
      game("skate"),
      { kind: PlayChangeKind.Mobile, mobileSupport: PlayMobileSupport.DesktopOnly },
      DONE,
    ) as PlayGame;
    assert.equal(curationOf(mobile).mobileSupport, PlayMobileSupport.DesktopOnly);
  });

  it("reads the mobile row as the admin's choice, else Auto's flag, else nothing", () => {
    const table: Array<[Partial<PlayCuration>, MobileShown | null]> = [
      [
        { mobileSupport: PlayMobileSupport.Supported, mobileAuto: PlayMobileSupport.DesktopOnly },
        MobileShown.Supported,
      ],
      [{ mobileSupport: null, mobileAuto: PlayMobileSupport.DesktopOnly }, MobileShown.AutoFlagged],
      [{ mobileSupport: null, mobileAuto: null }, null],
    ];
    for (const [curation, shown] of table) assert.equal(mobileShown({ ...CURATION, ...curation }), shown);
  });

  it("changes the game in every tab that shows it and leaves the others alone", () => {
    const state = {
      ...initialPlay(),
      feeds: {
        [PlayCategory.Featured]: ready([game("a"), game("b")]),
        [PlayCategory.Arcade]: ready([game("b")]),
        [PlayCategory.Sports]: ready([game("c")]),
      },
    };
    const next = gameChanged(state, game("b"), null);
    assert.deepEqual(slugs(next.feeds[PlayCategory.Featured]?.games), ["a"]);
    assert.deepEqual(slugs(next.feeds[PlayCategory.Arcade]?.games), []);
    assert.equal(next.feeds[PlayCategory.Sports], state.feeds[PlayCategory.Sports]);
    const renamed = gameChanged(state, game("a"), { ...game("a"), title: "NEW" });
    assert.deepEqual(
      renamed.feeds[PlayCategory.Featured]?.games.map((g) => g.title),
      ["NEW", "B"],
    );
  });

  it("drops a game that left the catalog from Recent and shows a new cover there", () => {
    const entry = (slug: string, coverUrl: string | null = null) => ({ slug, title: slug.toUpperCase(), coverUrl });
    const state = initialPlay([entry("a"), entry("b")]);
    assert.deepEqual(
      gameChanged(state, game("b"), null).recent.map((e) => e.slug),
      ["a"],
    );
    const covered = gameChanged(state, game("a"), {
      ...game("a"),
      coverUrl: "https://cdn.genex.technology/covers/a.webp",
    });
    assert.deepEqual(covered.recent[0], entry("a", "https://cdn.genex.technology/covers/a.webp"));
  });

  it("changes a profile's cards and leaves profiles without the game as they were", () => {
    const profile = (games: PlayGame[]) => ({
      status: LoadStatus.Ready,
      profile: { games } as unknown as PlayProfile,
    });
    const state = {
      ...initialPeople(),
      profiles: { owner: profile([game("a"), game("b")]), other: profile([game("c")]) },
    };
    const dropped = profileGameChanged(state, "id-b", null);
    assert.deepEqual(slugs(dropped.profiles.owner?.profile?.games), ["a"]);
    assert.equal(dropped.profiles.other, state.profiles.other);
    const off = changedGame(game("a"), { kind: PlayChangeKind.Remixing, allowed: false }, DONE);
    const changed = profileGameChanged(state, "id-a", off);
    assert.equal(curationOf(changed.profiles.owner?.profile?.games[0] as PlayGame).remixOff, true);
    assert.equal(profileGameChanged(state, "id-zzz", null), state);
  });
});

describe("Play card menu: the store's manage", () => {
  /** A store over a fake API whose tabs show `games`; every feed read and change is recorded. */
  function storeWith(games: PlayGame[], answer: () => Promise<PlayChangeResult>) {
    const reads: PlayCategory[] = [];
    const changes: Array<{ gameId: string; change: PlayGameChange }> = [];
    const heard: Array<{ gameId: string; next: PlayGame | null }> = [];
    const page = (shown: PlayGame[]): PlayFeedPage => ({ games: shown, nextCursor: null });
    const store = createPlayStore(
      {
        playFeed: async ({ category }) => {
          reads.push(category);
          return page(games);
        },
        playShelves: async () => ({ counts: { games: null, tools: null, assets: null }, categories: [] }),
        playOnline: async () => ({}),
        playOpen: async () => {},
        playClose: async () => {},
        playRemix: async (slug) => slug,
        playRemixReady: async (slugs) => Object.fromEntries(slugs.map((slug) => [slug, true])),
        assetLibrary: async () => ({ assets: [], nextCursor: null }),
        playCatalog: async () => [],
        playGame: async () => {
          throw new Error("no page");
        },
        playInstalls: async () => NO_INSTALLS,
        playSessions: async () => [],
        playInstall: async () => {},
        playInstallCancel: async () => {},
        playUninstall: async () => {},
        playForgetIdentity: async () => {},
        playLaunch: async () => {},
        playSession: async () => {},
        playManage: (gameId, change) => {
          changes.push({ gameId, change });
          return answer();
        },
      },
      null,
      () => 1_000,
      (gameId, next) => heard.push({ gameId, next }),
    );
    return { store, reads, changes, heard };
  }

  it("sends the change once, drops a deleted game from the tab and reads nothing again", async () => {
    const shown = [game("a"), game("b")];
    const { store, reads, changes, heard } = storeWith(shown, async () => DONE);
    await store.loadFeed(PlayCategory.Featured);
    reads.length = 0;
    await store.manage(shown[1] as PlayGame, { kind: PlayChangeKind.Delete });
    assert.deepEqual(changes, [{ gameId: "id-b", change: { kind: PlayChangeKind.Delete } }]);
    assert.deepEqual(slugs(store.getState().feeds[PlayCategory.Featured]?.games), ["a"]);
    assert.deepEqual(reads, []);
    assert.deepEqual(heard, [{ gameId: "id-b", next: null }]);
  });

  it("never shows a deleted game again, even from a page that was read before it went", async () => {
    const shown = [game("a"), game("b")];
    const { store } = storeWith(shown, async () => DONE);
    await store.loadFeed(PlayCategory.Featured);
    await store.manage(shown[1] as PlayGame, { kind: PlayChangeKind.Delete });
    await store.loadFeed(PlayCategory.Featured, { force: true });
    await store.loadFeed(PlayCategory.Arcade);
    assert.deepEqual(slugs(store.getState().feeds[PlayCategory.Featured]?.games), ["a"]);
    assert.deepEqual(slugs(store.getState().feeds[PlayCategory.Arcade]?.games), ["a"]);
  });

  it("changes nothing on screen when genex.games refuses, and passes the failure on", async () => {
    const shown = [game("a")];
    const { store, heard } = storeWith(shown, () => Promise.reject(new Error("HTTP 403")));
    await store.loadFeed(PlayCategory.Featured);
    const before = store.getState();
    await assert.rejects(store.manage(shown[0] as PlayGame, { kind: PlayChangeKind.Delete }));
    assert.equal(store.getState(), before);
    assert.deepEqual(heard, []);
  });

  it("keeps the card when remixing can't be turned on from here", async () => {
    const shown = [game("a", true)];
    const { store } = storeWith(shown, async () => ({ outcome: PlayChangeOutcome.OwnRepo }));
    await store.loadFeed(PlayCategory.Featured);
    const before = store.getState();
    const result = await store.manage(shown[0] as PlayGame, { kind: PlayChangeKind.Remixing, allowed: true });
    assert.equal(result.outcome, PlayChangeOutcome.OwnRepo);
    assert.equal(store.getState(), before);
  });
});
