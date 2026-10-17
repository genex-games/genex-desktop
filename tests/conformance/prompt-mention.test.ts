/**
 * @ tags in the prompt (src/shared/prompt-mention.ts) and what the picker offers
 * (src/shared/mention-corpus.ts): the text rules and the corpus, tested without a window.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  atomicBackspaceRange,
  handleOf,
  insertMention,
  mentionQueryAt,
  PROMPT_MENTION_MAX,
  scanMentionTokens,
  sentMentions,
  splitMentions,
} from "../../src/shared/prompt-mention.ts";
import { PlayShelf } from "../../src/shared/play.ts";
import { gridTarget } from "../../src/renderer/ui/mention-grid.ts";
import {
  type GenexCatalogItem,
  mentionCorpus,
  MentionShelf,
  mentionShelves,
  searchMentions,
} from "../../src/shared/mention-corpus.ts";

const known = new Set(["neon-rush", "midnight-apex-remix", "water"]);

describe("prompt tags", () => {
  it("finds only picked handles that start a word", () => {
    const text = "mix @neon-rush with @unknown and mail me@neon-rush.com, (@water)";
    assert.deepEqual(
      scanMentionTokens(text, known).map((t) => [t.handle, text.slice(t.start, t.end)]),
      [
        ["neon-rush", "@neon-rush"],
        ["water", "@water"],
      ],
    );
  });

  it("stops a tag at punctuation and keeps a longer known handle whole", () => {
    const tokens = scanMentionTokens("take @midnight-apex-remix, then @neon-rush-2", known);
    assert.deepEqual(
      tokens.map((t) => t.handle),
      ["midnight-apex-remix", "neon-rush"],
    );
  });

  it("an edited tag is plain text again", () => {
    assert.deepEqual(scanMentionTokens("mix @neon-rus", known), []);
  });

  it("splits text into plain runs and tags", () => {
    assert.deepEqual(splitMentions("a @water b", known), [
      { text: "a ", handle: null },
      { text: "@water", handle: "water" },
      { text: " b", handle: null },
    ]);
  });

  it("reads the @ query at the caret and nothing else", () => {
    assert.deepEqual(mentionQueryAt("mix @neo", 8), { start: 4, query: "neo" });
    assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" });
    assert.equal(mentionQueryAt("mix @neo rush", 13), null);
    assert.equal(mentionQueryAt("me@neo", 6), null);
    assert.equal(mentionQueryAt("mix", null), null);
  });

  it("a pick replaces the query and adds one space", () => {
    assert.deepEqual(insertMention("mix @ne", 7, "neon-rush", { start: 4, query: "ne" }), {
      value: "mix @neon-rush ",
      caret: 15,
    });
    assert.deepEqual(insertMention("mix @ne and", 7, "neon-rush", { start: 4, query: "ne" }), {
      value: "mix @neon-rush and",
      caret: 14,
    });
  });

  it("one Backspace after a whole tag removes it, and only then", () => {
    const text = "mix @neon-rush";
    assert.deepEqual(atomicBackspaceRange(text, 14, 14, known), { start: 4, end: 14 });
    assert.equal(atomicBackspaceRange(text, 10, 10, known), null);
    assert.equal(atomicBackspaceRange(text, 4, 14, known), null);
    assert.equal(atomicBackspaceRange("mix ", 4, 4, known), null);
  });

  it("sends the tags in text order, once each, at most five", () => {
    const picked = new Map(["a", "b", "c", "d", "e", "f"].map((h) => [h, h]));
    assert.deepEqual(sentMentions("@b then @a and @b", picked), ["b", "a"]);
    assert.equal(sentMentions("@a @b @c @d @e @f", picked).length, PROMPT_MENTION_MAX);
    assert.deepEqual(sentMentions("@zz", picked), []);
  });

  it("folds names into handles", () => {
    assert.equal(handleOf("Blame-mega-structure"), "blame-mega-structure");
    assert.equal(handleOf("Café  Racer!"), "cafe-racer");
    assert.equal(handleOf("Пока горит"), "game");
  });
});

function item(over: Partial<GenexCatalogItem> & { slug: string }): GenexCatalogItem {
  return {
    title: over.slug,
    description: "",
    shelf: PlayShelf.Games,
    authorId: "someone",
    thumbnailUrl: null,
    playsCount: 0,
    remixable: true,
    ...over,
  };
}

describe("picker corpus", () => {
  const catalog = {
    userId: "me",
    items: [
      item({ slug: "midnight-apex-remix", authorId: "me", thumbnailUrl: "https://cdn/apex.webp", playsCount: 8 }),
      item({ slug: "private-draft", authorId: "me", remixable: false }),
      item({ slug: "closed-game", remixable: false }),
      item({ slug: "neon-rush", title: "Neon Rush", playsCount: 60 }),
      item({ slug: "car-evolve", playsCount: 90 }),
      item({ slug: "stone-fireplace", title: "Stone Fireplace", shelf: PlayShelf.Assets }),
      item({ slug: "stylized-water", title: "Stylized Water", shelf: PlayShelf.Tools, description: "racing water" }),
    ],
  };
  const local = [
    { name: "Midnight Apex Remix", title: "Racing", coverUrl: "data:local" },
    { name: "Neon Rush", title: "My neon", coverUrl: null },
  ];

  it("offers own work and takeable things only, with a published local game standing for its twin", () => {
    const docs = mentionCorpus(local, catalog);
    assert.deepEqual(
      docs.map((d) => [d.handle, d.origin, d.own]),
      [
        ["midnight-apex-remix", "local", true],
        ["neon-rush", "local", true],
        ["private-draft", "genex", true],
        ["neon-rush-2", "genex", false],
        ["car-evolve", "genex", false],
        ["stone-fireplace", "genex", false],
        ["stylized-water", "genex", false],
      ],
    );
    assert.equal(docs[0]?.coverUrl, "https://cdn/apex.webp");
    assert.equal(docs[0]?.game, "Midnight Apex Remix");
  });

  it("signed out, nothing on genex.games is the person's own", () => {
    const docs = mentionCorpus([], { ...catalog, userId: null });
    assert.ok(docs.every((d) => !d.own));
    assert.ok(!docs.some((d) => d.slug === "private-draft"));
  });

  it("shelves the empty picker: your games, assets, tools, then games by plays", () => {
    const shelves = mentionShelves(mentionCorpus(local, catalog));
    assert.deepEqual(
      shelves.map((s) => [s.shelf, s.docs.map((d) => d.handle)]),
      [
        [MentionShelf.Yours, ["midnight-apex-remix", "neon-rush", "private-draft"]],
        [MentionShelf.Assets, ["stone-fireplace"]],
        [MentionShelf.Tools, ["stylized-water"]],
        [MentionShelf.Games, ["car-evolve", "neon-rush-2"]],
      ],
    );
  });

  it("ranks a typed query: own work and tools up, every word must match", () => {
    const docs = mentionCorpus(local, catalog);
    assert.deepEqual(
      searchMentions(docs, "neon").map((d) => d.handle),
      ["neon-rush", "neon-rush-2"],
    );
    assert.deepEqual(
      searchMentions(docs, "water").map((d) => d.handle),
      ["stylized-water"],
    );
    assert.deepEqual(searchMentions(docs, "stone zebra"), []);
    assert.deepEqual(searchMentions(docs, "  "), []);
  });
});

describe("picker keys", () => {
  // Five cards two across, then two rows: [0 1] [2 3] [4] then rows 5, 6.
  const shape = { cards: 5, rows: 2, columns: 2 };

  it("walks the cards' grid and steps into the rows below it", () => {
    assert.equal(gridTarget("ArrowRight", 0, shape), 1);
    assert.equal(gridTarget("ArrowDown", 1, shape), 3);
    assert.equal(gridTarget("ArrowDown", 3, shape), 5);
    assert.equal(gridTarget("ArrowDown", 4, shape), 5);
    assert.equal(gridTarget("ArrowDown", 5, shape), 6);
    assert.equal(gridTarget("ArrowDown", 6, shape), 6);
    assert.equal(gridTarget("ArrowUp", 5, shape), 4);
    assert.equal(gridTarget("ArrowUp", 6, shape), 5);
    assert.equal(gridTarget("ArrowUp", 3, shape), 1);
    assert.equal(gridTarget("ArrowUp", 1, shape), 1);
    assert.equal(gridTarget("ArrowLeft", 0, shape), 0);
  });

  it("a row above the cards (Images) steps down into the first card and back up", () => {
    const led = { lead: 1, cards: 4, rows: 0, columns: 2 };
    assert.equal(gridTarget("ArrowDown", 0, led), 1);
    assert.equal(gridTarget("ArrowUp", 1, led), 0);
    assert.equal(gridTarget("ArrowUp", 2, led), 0);
    assert.equal(gridTarget("ArrowDown", 1, led), 3);
    assert.equal(gridTarget("ArrowUp", 0, led), 0);
  });

  it("leaves other keys and an empty picker to the text box", () => {
    assert.equal(gridTarget("Enter", 0, shape), null);
    assert.equal(gridTarget("ArrowDown", 0, { cards: 0, rows: 0, columns: 2 }), null);
  });

  it("with no rows, down from the last line stays on the cards", () => {
    assert.equal(gridTarget("ArrowDown", 3, { cards: 5, rows: 0, columns: 2 }), 4);
    assert.equal(gridTarget("ArrowDown", 4, { cards: 5, rows: 0, columns: 2 }), 4);
  });
});
