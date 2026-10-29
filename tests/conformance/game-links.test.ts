/**
 * Links that open a game in Genex, as the website's "Open in Genex" sends them
 * (`genex://game/<slug>`): only a game's own address is taken, from macOS's open-url or from the
 * arguments Windows and Linux start Genex with; anything else is ignored and opens nothing. The
 * newest link waits until the studio page takes it, once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gameLinkIn, gameLinks, gameLinkSlug } from "../../src/main/play/game-links.ts";

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
    assert.equal(links.take(), "iron-tide");
  });

  it("shows the window, tells the page, and keeps the newest link until the page takes it once", () => {
    const { links, calls } = queue();
    assert.equal(links.arrive("genex://game/iron-tide"), true);
    assert.equal(links.arrive("genex://game/puck-rush"), true);
    assert.deepEqual(calls, ["show", "announce", "show", "announce"]);
    assert.equal(links.take(), "puck-rush");
    assert.equal(links.take(), null, "taken once");
  });

  it("does nothing for a link it ignores, and keeps the one waiting", () => {
    const { links, calls } = queue();
    links.arrive("genex://game/iron-tide");
    calls.length = 0;
    for (const link of ["genex://world/x", null, "https://genex.games/"]) assert.equal(links.arrive(link), false);
    assert.deepEqual(calls, [], "no window shown, no page told");
    assert.equal(links.take(), "iron-tide");
  });
});
