/**
 * Links that open a game in Genex, as the website's "Open in Genex" sends them
 * (`genex://game/<slug>`): only a game's own address is taken, from macOS's open-url or from the
 * arguments Windows and Linux start Genex with; anything else is ignored and opens nothing. The
 * newest link waits until the studio page takes it, once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GameLinkKind,
  gameLinkIn,
  gameLinks,
  gameLinkSlug,
  gameLinkTarget,
  linkOpening,
} from "../../src/main/play/game-links.ts";

describe("a link that opens a game in Genex", () => {
  it("names a game by its address", () => {
    assert.equal(gameLinkSlug("genex://game/lost-cathedral"), "lost-cathedral");
    assert.equal(gameLinkSlug("genex://game/lost-cathedral/"), "lost-cathedral", "a trailing slash is the same game");
    assert.equal(gameLinkSlug("genex://game/a1"), "a1");
  });

  it("ignores every other link", () => {
    const hostile: unknown[] = [
      "https://genex.games/game/lost-cathedral",
      "genex://world/lost-cathedral",
      "genex://game/",
      "genex://game",
      "genex:game/lost-cathedral",
      "genex://game/lost-cathedral/comments",
      "genex://game/Lost-Cathedral",
      "genex://game/lost-cathedral-",
      "genex://game/-lost",
      "genex://game/lost%2Fcathedral",
      "genex://game/%2e%2e",
      "genex://game/..%2Fsettings",
      "genex://game/lost-cathedral?install=1",
      "genex://game/lost-cathedral#play",
      "genex://user:pass@game/lost-cathedral",
      "genex://game:8080/lost-cathedral",
      "genex://GAME/lost-cathedral",
      `genex://game/${"a".repeat(101)}`,
      `genex://game/lost-cathedral${" ".repeat(4096)}`,
      "javascript:alert(1)",
      "",
      null,
      42,
      { href: "genex://game/lost-cathedral" },
    ];
    for (const link of hostile) assert.equal(gameLinkSlug(link), null, JSON.stringify(link));
  });

  it("is found among the arguments Genex starts with, and only as a link of its own", () => {
    assert.equal(gameLinkIn(["Genex.exe", "--flag", "genex://game/puck-rush"]), "genex://game/puck-rush");
    assert.equal(gameLinkIn(["Genex.exe", "GENEX://game/puck-rush"]), "GENEX://game/puck-rush");
    assert.equal(gameLinkIn(["Genex.exe", "--open=genex://game/puck-rush"]), null);
    assert.equal(gameLinkIn(["Genex.exe"]), null);
  });
});

describe("links waiting for the studio page", () => {
  /** A queue whose window and page are recorders, listened to. */
  function queue() {
    const calls: string[] = [];
    const links = gameLinks();
    links.listen({ show: () => calls.push("show"), announce: () => calls.push("announce") });
    return { links, calls };
  }

  it("keeps a link that arrives before main listens, without a window to show or a page to tell", () => {
    const links = gameLinks();
    assert.equal(links.arrive("genex://game/iron-tide"), true);
    const calls: string[] = [];
    links.listen({ show: () => calls.push("show"), announce: () => calls.push("announce") });
    assert.deepEqual(calls, [], "the window opening at start takes it");
    assert.deepEqual(links.take(), { kind: GameLinkKind.Game, slug: "iron-tide" });
  });

  it("shows the window, tells the page, and keeps the newest link until the page takes it once", () => {
    const { links, calls } = queue();
    assert.equal(links.arrive("genex://game/iron-tide"), true);
    assert.equal(links.arrive("genex://game/puck-rush"), true);
    assert.deepEqual(calls, ["show", "announce", "show", "announce"]);
    assert.deepEqual(links.take(), { kind: GameLinkKind.Game, slug: "puck-rush" });
    assert.equal(links.take(), null, "taken once");
  });

  it("does nothing for a link it ignores, and keeps the one waiting", () => {
    const { links, calls } = queue();
    links.arrive("genex://game/iron-tide");
    calls.length = 0;
    for (const link of ["genex://world/x", null, "https://genex.games/"]) assert.equal(links.arrive(link), false);
    assert.deepEqual(calls, [], "no window shown, no page told");
    assert.deepEqual(links.take(), { kind: GameLinkKind.Game, slug: "iron-tide" });
  });
});

describe("a link that opens the creator's own game in Genex Studio", () => {
  it("names the game by its link on Genex", () => {
    assert.deepEqual(gameLinkTarget("genex://create/midnight-asphalt"), {
      kind: GameLinkKind.Create,
      slug: "midnight-asphalt",
    });
    assert.deepEqual(gameLinkTarget("genex://create/midnight-asphalt/"), {
      kind: GameLinkKind.Create,
      slug: "midnight-asphalt",
    });
    assert.equal(gameLinkSlug("genex://create/midnight-asphalt"), null, "not a page in Play by itself");
  });

  it("ignores every other link, and nothing waits, shows or is told for one", () => {
    const hostile: unknown[] = [
      // a wrong scheme or host
      "https://genex.games/create/midnight-asphalt",
      "genex:create/midnight-asphalt",
      "genex://creat/midnight-asphalt",
      "genex://creates/midnight-asphalt",
      "genex://draft/midnight-asphalt",
      "genex:///create/midnight-asphalt",
      // extra parts
      "genex://user@create/midnight-asphalt",
      "genex://user:pass@create/midnight-asphalt",
      "genex://create:443/midnight-asphalt",
      "genex://create/midnight-asphalt?review=request",
      "genex://create/midnight-asphalt#publish",
      "genex://create/midnight-asphalt/publish",
      // a bad slug
      "genex://create/",
      "genex://create",
      "genex://create/-midnight",
      "genex://create/midnight-",
      "genex://create/midnight%2Fasphalt",
      "genex://create/%2e%2e",
      "genex://create/..%2F..%2Fsettings",
      "genex://create/midnight asphalt",
      "genex://create/midnight_asphalt",
      // an over-long link
      `genex://create/${"a".repeat(101)}`,
      `genex://create/midnight-asphalt${" ".repeat(4096)}`,
      `genex://create/${"a".repeat(300)}`,
      // mixed case
      "genex://Create/midnight-asphalt",
      "genex://CREATE/midnight-asphalt",
      "genex://create/Midnight-Asphalt",
      // not a link at all
      null,
      undefined,
      7,
      { href: "genex://create/midnight-asphalt" },
    ];
    for (const link of hostile) {
      assert.equal(gameLinkTarget(link), null, JSON.stringify(link));
      const calls: string[] = [];
      const links = gameLinks();
      links.listen({ show: () => calls.push("show"), announce: () => calls.push("announce") });
      assert.equal(links.arrive(link), false, JSON.stringify(link));
      assert.deepEqual(calls, [], `${JSON.stringify(link)} shows nothing and tells the page nothing`);
      assert.equal(links.take(), null, `${JSON.stringify(link)} leaves nothing waiting`);
    }
  });

  it("opens the library's own game with that link, else the game's page in Play", async () => {
    const asked: string[] = [];
    const here = async (slug: string) => {
      asked.push(slug);
      return slug === "midnight-asphalt" ? "midnight" : null;
    };
    const create = gameLinkTarget("genex://create/midnight-asphalt");
    assert.deepEqual(await linkOpening(create, here), { slug: "midnight-asphalt", project: "midnight" });
    assert.deepEqual(await linkOpening(gameLinkTarget("genex://create/iron-tide"), here), { slug: "iron-tide" });
    assert.deepEqual(await linkOpening(gameLinkTarget("genex://game/midnight-asphalt"), here), {
      slug: "midnight-asphalt",
    });
    assert.deepEqual(asked, ["midnight-asphalt", "iron-tide"], "a game link never looks for a game here");
    assert.equal(await linkOpening(null, here), null);
    const failing = async () => Promise.reject(new Error("the library is loading"));
    assert.deepEqual(await linkOpening(create, failing), { slug: "midnight-asphalt" });
  });
});
