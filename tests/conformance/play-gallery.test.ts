/**
 * Play's gallery: main reads genex.games' catalog for the dashboard, anonymously, and signs only a
 * like, an identity ticket and an invite with the Genex account's token. What the API answers is
 * hostile input: a card is drawn only from an item that names a game, and an image or a git address
 * outside Genex's own hosts is never handed on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type GalleryAnswer,
  type GalleryRequest,
  networkRequest,
  PlayRoute,
  playGallery,
  SignInNeeded,
  TicketStatus,
  toFeedPage,
  toPlayGame,
  visibleShelves,
} from "../../src/main/play/gallery.ts";
import { PlayCategory, PlayShelf } from "../../src/shared/play.ts";

const TOKEN = "genex-cli-token";

/** An item as the gallery serves it. */
function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cm1",
    slug: "lost-cathedral",
    title: "Lost Cathedral",
    description: "A cathedral to get lost in.",
    thumbnailUrl: "https://cdn.genex.technology/covers/cm1.webp?v=1",
    playUrl: "https://lost-cathedral.genex.technology/",
    cloneUrl: "https://git.genex.games/u-1/lost-cathedral.git",
    purchaseUrl: null,
    private: false,
    multiplayer: false,
    playsCount: 2682,
    online: null,
    author: {
      id: "u1",
      name: "Simeon M",
      image: "https://api.genex.games/api/character-assets/avatars/u1/1.webp",
      avatarStyle: "photo",
    },
    ...overrides,
  };
}

interface Call {
  route: string;
  method: string;
  token?: string;
  body?: unknown;
}

/** A gallery over a scripted API: each route answers what `answers` says, and every call is kept. */
function rig(
  answers: (call: Call) => GalleryAnswer | Promise<GalleryAnswer>,
  options: { token?: string | undefined; now?: number } = {},
) {
  const token = "token" in options ? options.token : TOKEN;
  const calls: Call[] = [];
  let clock = options.now ?? 1_000_000;
  const request: GalleryRequest = async (route, init) => {
    const call: Call = { route, method: init.method ?? "GET", ...init };
    calls.push(call);
    return answers(call);
  };
  const gallery = playGallery({ request, token: async () => token, now: () => clock });
  return { gallery, calls, advance: (ms: number) => (clock += ms) };
}

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });

describe("Play gallery items", () => {
  it("draws a card from a gallery item", () => {
    assert.deepEqual(toPlayGame(item()), {
      id: "cm1",
      slug: "lost-cathedral",
      title: "Lost Cathedral",
      description: "A cathedral to get lost in.",
      coverUrl: "https://cdn.genex.technology/covers/cm1.webp?v=1",
      clipUrl: null,
      multiplayer: false,
      plays: 2682,
      online: null,
      author: {
        id: "u1",
        name: "Simeon M",
        imageUrl: "https://api.genex.games/api/character-assets/avatars/u1/1.webp",
      },
      remixable: true,
    });
  });

  it("hands on the maker's picture only when they chose it as their avatar", () => {
    const author = (avatarStyle?: string) =>
      toPlayGame(item({ author: { id: "u1", name: "Simeon M", image: "https://api.genex.games/a.webp", avatarStyle } }))
        ?.author.imageUrl;
    assert.equal(author("photo"), "https://api.genex.games/a.webp");
    assert.equal(author("generated"), null);
    assert.equal(author(), null, "while genex.games does not say, the generated avatar shows");
  });

  it("refuses an item that does not name a game", () => {
    const bad: unknown[] = [
      null,
      "game",
      [],
      item({ id: "" }),
      item({ title: "   " }),
      item({ slug: "../etc" }),
      item({ slug: "Upper" }),
      item({ slug: "a.b" }),
      item({ slug: "-dash" }),
      item({ slug: 7 }),
    ];
    for (const value of bad) assert.equal(toPlayGame(value), null, JSON.stringify(value));
  });

  it("never hands on an image from outside Genex's hosts", () => {
    const hostile = [
      "http://cdn.genex.technology/covers/cm1.webp",
      "https://evil.example/cover.webp",
      "https://cdn.genex.technology.evil.example/a.webp",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "file:///etc/passwd",
      "not a url",
      42,
    ];
    for (const thumbnailUrl of hostile) {
      const game = toPlayGame(item({ thumbnailUrl, author: { name: "A", image: thumbnailUrl } }));
      assert.equal(game?.coverUrl, null, String(thumbnailUrl));
      assert.equal(game?.author.imageUrl, null, String(thumbnailUrl));
    }
  });

  it("hands on a cover clip from Genex's CDN, over a cover only", () => {
    const clip = "https://cdn.genex.technology/covers/cm1/0b6f6a2e-1c1f-4c63-9a55-2f4e7c1d2a11.mp4";
    assert.equal(toPlayGame(item({ coverClipUrl: clip }))?.clipUrl, clip);
    assert.equal(toPlayGame(item())?.clipUrl, null, "no clip yet");
    assert.equal(
      toPlayGame(item({ coverClipUrl: clip, thumbnailUrl: null }))?.clipUrl,
      null,
      "a clip plays over its still",
    );
  });

  it("never hands on a clip from anywhere but Genex's cover folder", () => {
    const hostile = [
      "http://cdn.genex.technology/covers/cm1/a.mp4",
      "https://evil.example/covers/cm1/a.mp4",
      "https://cdn.genex.technology.evil.example/covers/cm1/a.mp4",
      "https://user:pass@cdn.genex.technology/covers/cm1/a.mp4",
      "https://cdn.genex.technology:8443/covers/cm1/a.mp4",
      "https://cdn.genex.technology/avatars/cm1/a.mp4",
      "https://cdn.genex.technology/covers/cm1/a.webm",
      "https://assets.genex.games/covers/cm1/a.mp4",
      "javascript:alert(1)",
      "data:video/mp4;base64,AAAA",
      "blob:https://cdn.genex.technology/1",
      "not a url",
      42,
      {},
    ];
    for (const coverClipUrl of hostile)
      assert.equal(toPlayGame(item({ coverClipUrl }))?.clipUrl, null, JSON.stringify(coverClipUrl));
  });

  it("offers a remix only for public source on Genex's own git", () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{}, true],
      [{ private: true }, false],
      [{ purchaseUrl: "https://shop.example/x" }, false],
      [{ cloneUrl: null }, false],
      [{ cloneUrl: "https://github.com/someone/game.git" }, false],
      [{ cloneUrl: "http://git.genex.games/u-1/game.git" }, false],
      [{ cloneUrl: "https://git.genex.games/u-1/game" }, false],
      [{ cloneUrl: "ext::sh -c touch% /tmp/pwned" }, false],
    ];
    for (const [overrides, remixable] of cases)
      assert.equal(toPlayGame(item(overrides))?.remixable, remixable, JSON.stringify(overrides));
  });

  it("counts players only in a multiplayer game", () => {
    assert.equal(toPlayGame(item({ multiplayer: true, online: 6 }))?.online, 6);
    assert.equal(toPlayGame(item({ multiplayer: true, online: null }))?.online, null);
    assert.equal(toPlayGame(item({ multiplayer: false, online: 6 }))?.online, null);
    assert.equal(toPlayGame(item({ playsCount: -3 }))?.plays, 0);
  });

  it("keeps each game once and the next cursor", () => {
    const page = toFeedPage({
      items: [item(), item(), item({ id: "cm2", slug: "wildfire" }), "junk"],
      nextCursor: "cm2",
    });
    assert.deepEqual(
      page.games.map((game) => game.slug),
      ["lost-cathedral", "wildfire"],
    );
    assert.equal(page.nextCursor, "cm2");
    assert.deepEqual(toFeedPage({ items: "nope" }), { games: [], nextCursor: null });
  });

  it("counts each shelf and shows its first tab and every tab with something in it, in the website's order", () => {
    const body = {
      buckets: { games: 59, tools: 16, assets: 44 },
      values: { sports: 1, arcade: 2, shooter: 0, vfx: 9, fighting: 1, physics: 3, terrain: -1 },
    };
    assert.deepEqual(visibleShelves(body), {
      counts: { [PlayShelf.Games]: 59, [PlayShelf.Tools]: 16, [PlayShelf.Assets]: 44 },
      categories: [
        PlayCategory.Featured,
        PlayCategory.Arcade,
        PlayCategory.Sports,
        PlayCategory.Fighting,
        PlayCategory.Tools,
        PlayCategory.Physics,
        PlayCategory.Vfx,
        PlayCategory.Assets,
      ],
    });
    assert.deepEqual(visibleShelves(null), {
      counts: { [PlayShelf.Games]: null, [PlayShelf.Tools]: null, [PlayShelf.Assets]: null },
      categories: [PlayCategory.Featured, PlayCategory.Tools, PlayCategory.Assets],
    });
  });
});

describe("Play gallery calls", () => {
  it("reads a tab anonymously, with its category and cursor", async () => {
    const { gallery, calls } = rig(() => ok({ items: [item()], nextCursor: null }));
    await gallery.feed({ category: PlayCategory.Featured });
    await gallery.feed({ category: PlayCategory.Arcade, cursor: "cm9" });
    assert.deepEqual(
      calls.map((call) => [call.route, call.token]),
      [
        [`${PlayRoute.Feed}?limit=24`, undefined],
        [`${PlayRoute.Feed}?limit=24&category=arcade&cursor=cm9`, undefined],
      ],
    );
  });

  it("drops a cursor that is not an id, and refuses an unknown tab", async () => {
    const { gallery, calls } = rig(() => ok({ items: [] }));
    await gallery.feed({ category: PlayCategory.Sports, cursor: "x&category=assets" });
    assert.equal(calls[0]?.route, `${PlayRoute.Feed}?limit=24&category=sports`);
    await assert.rejects(gallery.feed({ category: "pets" as PlayCategory }), /Unknown Play category/);
    assert.equal(calls.length, 1);
  });

  it("answers a tab's first page from a minute-old copy, then reads it again", async () => {
    const { gallery, calls, advance } = rig(() => ok({ items: [item()] }));
    await gallery.feed({ category: PlayCategory.Featured });
    await gallery.feed({ category: PlayCategory.Featured });
    assert.equal(calls.length, 1);
    advance(61_000);
    await gallery.feed({ category: PlayCategory.Featured });
    assert.equal(calls.length, 2);
  });

  it("keeps only the items on a tab's own shelf", async () => {
    const items = [
      item({ id: "g1", slug: "stick-and-steel", categories: ["games", "physics"] }),
      item({ id: "t1", slug: "box3d", categories: ["tools", "physics"] }),
      item({ id: "a1", slug: "fireplace", categories: ["assets"] }),
      item({ id: "g2", slug: "lost-cathedral" }),
    ];
    const { gallery, calls } = rig(() => ok({ items, nextCursor: null }));
    const slugs = async (category: PlayCategory) => (await gallery.feed({ category })).games.map((game) => game.slug);
    assert.deepEqual(await slugs(PlayCategory.Physics), ["box3d"]);
    assert.deepEqual(await slugs(PlayCategory.Featured), ["stick-and-steel", "lost-cathedral"]);
    assert.deepEqual(await slugs(PlayCategory.Tools), ["box3d"]);
    assert.deepEqual(await slugs(PlayCategory.Assets), ["fireplace"]);
    assert.deepEqual(
      calls.map((call) => call.route),
      [
        `${PlayRoute.Feed}?limit=24&category=physics`,
        `${PlayRoute.Feed}?limit=24`,
        `${PlayRoute.Feed}?limit=24&category=tools`,
        `${PlayRoute.Feed}?limit=24&category=assets`,
      ],
    );
  });

  it("throws a failed read with its status", async () => {
    const { gallery } = rig(() => ({ status: 503, body: null }));
    await assert.rejects(gallery.feed({ category: PlayCategory.Featured }), { status: 503 });
  });

  it("throws counts it cannot read, so the dashboard keeps the tabs and counts it has (offline too)", async () => {
    await assert.rejects(rig(() => ({ status: 500, body: null })).gallery.shelves(), { status: 500 });
    const offline = rig(() => Promise.reject(new TypeError("fetch failed")));
    await assert.rejects(offline.gallery.shelves(), TypeError);
  });

  it("puts an item tagged both tools and assets on Assets, as the website buckets it", async () => {
    const items = [item({ id: "x1", slug: "rock-kit", categories: ["tools", "assets"] })];
    const { gallery } = rig(() => ok({ items, nextCursor: null }));
    const slugs = async (category: PlayCategory) => (await gallery.feed({ category })).games.map((game) => game.slug);
    assert.deepEqual(await slugs(PlayCategory.Assets), ["rock-kit"]);
    assert.deepEqual(await slugs(PlayCategory.Tools), []);
  });

  it("asks for the players in named games only, 48 a read, with the time bucket", async () => {
    const slugs = ["a", "b", "../x", "a", ...Array.from({ length: 60 }, (_, i) => `g${i}`)];
    const { gallery, calls } = rig(() => ok({ online: { a: 3, b: "x", g59: 2 } }));
    assert.deepEqual(await gallery.online(slugs), { a: 3, g59: 2 });
    const asked = calls.map((call) => new URLSearchParams(call.route.split("?")[1]));
    assert.deepEqual(
      asked.map((query) => query.get("slugs")?.split(",").length),
      [48, 14],
    );
    assert.ok(asked.every((query) => !query.get("slugs")?.includes("..")));
    assert.equal(asked[0]?.get("t"), String(Math.floor(1_000_000 / 5000)));
    assert.deepEqual(await rig(() => ok({})).gallery.online([]), {});
  });

  it("likes with the account's token and needs one", async () => {
    const { gallery, calls } = rig(() => ok({ liked: true, likesCount: 4 }));
    assert.deepEqual(await gallery.setLiked("cm1", true), { liked: true, likes: 4 });
    await gallery.setLiked("cm1", false);
    assert.deepEqual(
      calls.map((call) => [call.method, call.route, call.token]),
      [
        ["PUT", PlayRoute.like("cm1"), TOKEN],
        ["DELETE", PlayRoute.like("cm1"), TOKEN],
      ],
    );
    const signedOut = rig(() => ok({}), { token: undefined });
    await assert.rejects(signedOut.gallery.setLiked("cm1", true), SignInNeeded);
    assert.equal(signedOut.calls.length, 0);
    await assert.rejects(rig(() => ({ status: 401, body: null })).gallery.setLiked("cm1", true), SignInNeeded);
  });

  it("mints a redirect ticket for a signed-in player, and tells signed out apart from a mint that failed", async () => {
    const { gallery, calls } = rig(() => ok({ ticket: "T1" }));
    assert.deepEqual(await gallery.ticket("lost-cathedral"), { status: TicketStatus.Minted, ticket: "T1" });
    assert.deepEqual(calls[0]?.body, { slug: "lost-cathedral", delivery: "redirect", channel: "production" });
    assert.equal(calls[0]?.token, TOKEN);
    const signedOut = rig(() => ok({ ticket: "T1" }), { token: undefined });
    assert.deepEqual(await signedOut.gallery.ticket("lost-cathedral"), { status: TicketStatus.SignedOut });
    assert.equal(signedOut.calls.length, 0);
    const notMinted: Array<[string, () => GalleryAnswer | Promise<GalleryAnswer>]> = [
      ["refused", () => ({ status: 403, body: null })],
      ["token rejected", () => ({ status: 401, body: null })],
      ["no ticket in the answer", () => ok({})],
      ["an empty ticket", () => ok({ ticket: "" })],
      ["unreachable", () => Promise.reject(new Error("offline"))],
    ];
    for (const [name, answer] of notMinted)
      assert.deepEqual(await rig(answer).gallery.ticket("lost-cathedral"), { status: TicketStatus.NotMinted }, name);
    assert.deepEqual(await gallery.ticket("../x"), { status: TicketStatus.NotMinted });
    assert.equal(calls.length, 1, "a slug that is not a game is never sent");
  });

  it("reads the search catalog once however many searches wait on it", async () => {
    let answer: (value: GalleryAnswer) => void = () => {};
    const { gallery, calls } = rig(() => new Promise<GalleryAnswer>((resolve) => (answer = resolve)));
    const searches = [gallery.search("lost"), gallery.search("cathedral")];
    answer(ok({ items: [item(), item({ id: "cm2", slug: "assets-pack", categories: ["assets"] })] }));
    const [first, second] = await Promise.all(searches);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      first.map((game) => game.slug),
      ["lost-cathedral"],
    );
    assert.deepEqual(
      second.map((game) => game.slug),
      ["lost-cathedral"],
    );
  });

  it("searches the shelf it is asked about, games when it names none it knows", async () => {
    const items = [
      item({ id: "g1", slug: "ocean-racer", title: "Ocean Racer" }),
      item({ id: "t1", slug: "poseidon", title: "Poseidon Ocean", categories: ["tools", "terrain"] }),
      item({ id: "a1", slug: "ocean-buoy", title: "Ocean Buoy", categories: ["assets"] }),
    ];
    const { gallery } = rig(() => ok({ items }));
    const found = async (shelf?: PlayShelf) => (await gallery.search("ocean", shelf)).map((game) => game.slug);
    assert.deepEqual(await found(PlayShelf.Tools), ["poseidon"]);
    assert.deepEqual(await found(PlayShelf.Assets), ["ocean-buoy"]);
    assert.deepEqual(await found(PlayShelf.Games), ["ocean-racer"]);
    assert.deepEqual(await found("x" as PlayShelf), ["ocean-racer"]);
  });

  it("reads a game's likes, whether it may be remixed and the facts its header shows", async () => {
    const { gallery, calls } = rig(() => ok({ item: { ...item(), likesCount: 42, likedByMe: true } }));
    assert.deepEqual(await gallery.world("lost-cathedral"), {
      id: "cm1",
      slug: "lost-cathedral",
      title: "Lost Cathedral",
      multiplayer: false,
      likes: 42,
      liked: true,
      remixable: true,
      cloneUrl: "https://git.genex.games/u-1/lost-cathedral.git",
      author: "Simeon M",
      authorId: "u1",
      plays: 2682,
      online: null,
    });
    assert.equal(calls[0]?.token, TOKEN);
    await assert.rejects(gallery.world("../../api"), /Not a game address/);
  });

  it("reads the invite code once per account and refuses a strange one", async () => {
    const { gallery, calls } = rig(() => ok({ code: "abc123" }));
    assert.equal(await gallery.inviteCode(), "abc123");
    assert.equal(await gallery.inviteCode(), "abc123");
    assert.equal(calls.length, 1);
    assert.equal(await rig(() => ok({ code: "a b&c" })).gallery.inviteCode(), undefined);
    assert.equal(await rig(() => ok({ code: "x" }), { token: undefined }).gallery.inviteCode(), undefined);
  });
});

describe("Play's network request", () => {
  /** A fetch that answers `status` with `text`, keeping what it was asked. */
  const fetchAnswering = (status: number, text: string) => {
    const asked: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return new Response(text, { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { fetchImpl, asked };
  };

  it("hands on the body of a refusal, so a write can say why it was refused", async () => {
    const { fetchImpl, asked } = fetchAnswering(400, JSON.stringify({ error: "handle_taken", suggestions: ["rab2"] }));
    const answer = await networkRequest(fetchImpl, "http://localhost:3000")("/api/users/me", {
      method: "PATCH",
      body: { handle: "rab" },
      token: TOKEN,
    });
    assert.deepEqual(answer, { status: 400, body: { error: "handle_taken", suggestions: ["rab2"] } });
    assert.equal(asked[0]?.url, "http://localhost:3000/api/users/me");
    assert.equal(new Headers(asked[0]?.init?.headers).get("authorization"), `Bearer ${TOKEN}`);
  });

  it("reads a body that is not JSON as none, whatever the status", async () => {
    for (const status of [200, 502]) {
      const { fetchImpl } = fetchAnswering(status, "<html>gateway</html>");
      assert.deepEqual(await networkRequest(fetchImpl, "https://api.genex.games")("/api/gallery", {}), {
        status,
        body: null,
      });
    }
  });
});
