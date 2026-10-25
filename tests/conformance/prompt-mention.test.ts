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
  filterMentions,
  type GenexCatalogItem,
  libraryHandle,
  MENTION_FILTER_ALL,
  mentionAdmits,
  mentionCorpus,
  type MentionFilter,
  MentionShelf,
  mentionShelves,
  MentionWhat,
  SHELF_CAPS,
  searchMentions,
  shelfCaps,
} from "../../src/shared/mention-corpus.ts";
import { AssetScope, type LibraryAsset, LibraryKind } from "../../src/shared/asset-library.ts";
import { MentionKind, MentionOrigin, mentionRef } from "../../src/shared/prompt-mention.ts";

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
    authorName: "Someone",
    thumbnailUrl: null,
    playsCount: 0,
    remixable: true,
    assetKind: null,
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

function libraryAsset(over: Partial<LibraryAsset> & { id: string; title: string }): LibraryAsset {
  return {
    kind: LibraryKind.Model,
    thumbnailUrl: `https://assets.genex.technology/thumbs/${over.id}.webp`,
    fileUrl: `https://assets.genex.technology/generations/${over.id}/file.glb`,
    fileKind: LibraryKind.Model,
    fileFormat: "glb",
    saved: false,
    shared: null,
    shareable: true,
    createdAt: "2026-10-17T09:00:00.000Z",
    ...over,
  };
}

describe("picker switchers", () => {
  const catalog = {
    userId: "me",
    items: [
      item({ slug: "my-racer", authorId: "me" }),
      item({ slug: "neon-rush", playsCount: 60 }),
      item({ slug: "my-tool", authorId: "me", shelf: PlayShelf.Tools }),
      item({ slug: "water", shelf: PlayShelf.Tools }),
      item({ slug: "my-chair", authorId: "me", shelf: PlayShelf.Assets, assetKind: LibraryKind.Model }),
      item({ slug: "fireplace", shelf: PlayShelf.Assets, playsCount: 99 }),
    ],
  };
  const library = [libraryAsset({ id: "gen-mushroom-01", title: "Giant mushroom tree" })];
  const docs = mentionCorpus([{ name: "Snowball", title: "Snowball", coverUrl: null }], catalog, library);
  const plugin = { kind: MentionKind.Plugin, own: false };
  const handles = (filter: MentionFilter) => filterMentions(docs, filter).map((doc) => doc.handle);
  const whats = Object.values(MentionWhat);
  const whoses = Object.values(AssetScope);
  const KIND_OF_WHAT = {
    [MentionWhat.Games]: MentionKind.Game,
    [MentionWhat.Assets]: MentionKind.Asset,
    [MentionWhat.Tools]: MentionKind.Tool,
  };

  it("Everyone keeps everything you may tag, one kind at a time or all of it", () => {
    const everyone = (what: MentionWhat) => handles({ what, whose: AssetScope.Everyone });
    assert.deepEqual(everyone(MentionWhat.All), [
      "snowball",
      "my-racer",
      "neon-rush",
      "my-tool",
      "water",
      "my-chair",
      "fireplace",
      "giant-mushroom-tree",
    ]);
    assert.deepEqual(everyone(MentionWhat.Games), ["snowball", "my-racer", "neon-rush"]);
    assert.deepEqual(everyone(MentionWhat.Tools), ["my-tool", "water"]);
    assert.deepEqual(everyone(MentionWhat.Assets), ["my-chair", "fireplace", "giant-mushroom-tree"]);
  });

  it("Mine keeps only your own: your games, your published work and your library", () => {
    const mine = (what: MentionWhat) => handles({ what, whose: AssetScope.Mine });
    assert.deepEqual(mine(MentionWhat.All), ["snowball", "my-racer", "my-tool", "my-chair", "giant-mushroom-tree"]);
    assert.deepEqual(mine(MentionWhat.Games), ["snowball", "my-racer"]);
    assert.deepEqual(mine(MentionWhat.Tools), ["my-tool"]);
    assert.deepEqual(mine(MentionWhat.Assets), ["my-chair", "giant-mushroom-tree"]);
  });

  it("every combination keeps only its kind and, under Mine, only your own", () => {
    for (const what of whats) {
      for (const whose of whoses) {
        for (const doc of filterMentions(docs, { what, whose })) {
          if (whose === AssetScope.Mine) assert.ok(doc.own, `${what}/${whose}: ${doc.handle}`);
          if (what !== MentionWhat.All) assert.equal(doc.kind, KIND_OF_WHAT[what], `${what}/${whose}: ${doc.handle}`);
        }
      }
    }
  });

  it("plugins show under All and Everyone only", () => {
    const admitted = whats.flatMap((what) =>
      whoses.filter((whose) => mentionAdmits(plugin, { what, whose })).map((whose) => `${what}/${whose}`),
    );
    assert.deepEqual(admitted, ["all/everyone"]);
    assert.deepEqual(MENTION_FILTER_ALL, { what: MentionWhat.All, whose: AssetScope.Everyone });
  });

  it("shelves your own assets apart, published ones before the library's, then everyone's", () => {
    const assets = mentionShelves(filterMentions(docs, { what: MentionWhat.Assets, whose: AssetScope.Everyone }));
    assert.deepEqual(
      assets.map((s) => [s.shelf, s.docs.map((d) => d.handle)]),
      [
        [MentionShelf.YourAssets, ["my-chair", "giant-mushroom-tree"]],
        [MentionShelf.Assets, ["fireplace"]],
      ],
    );
    const big = mentionCorpus(
      [],
      catalog,
      Array.from({ length: 20 }, (_, i) =>
        libraryAsset({ id: `gen-many-${String(i).padStart(4, "0")}`, title: `Rock ${i}` }),
      ),
    );
    const everyone = mentionShelves(filterMentions(big, MENTION_FILTER_ALL));
    assert.equal(
      everyone.find((s) => s.shelf === MentionShelf.YourAssets)?.docs.length,
      SHELF_CAPS[MentionShelf.YourAssets],
    );
    assert.deepEqual(
      everyone.find((s) => s.shelf === MentionShelf.Assets)?.docs.map((d) => d.handle),
      ["fireplace"],
      "a big library never pushes everyone's assets out",
    );
  });

  it("one kind alone gets a longer shelf", () => {
    assert.equal(shelfCaps(MENTION_FILTER_ALL), SHELF_CAPS);
    const narrow = shelfCaps({ what: MentionWhat.Assets, whose: AssetScope.Mine });
    assert.ok(narrow[MentionShelf.Assets] > SHELF_CAPS[MentionShelf.Assets]);
    assert.ok(narrow[MentionShelf.YourAssets] > SHELF_CAPS[MentionShelf.YourAssets]);
  });

  it("typed text searches within the switchers", () => {
    const mineAssets = filterMentions(docs, { what: MentionWhat.Assets, whose: AssetScope.Mine });
    assert.deepEqual(
      searchMentions(mineAssets, "mush").map((d) => d.handle),
      ["giant-mushroom-tree"],
    );
    assert.deepEqual(searchMentions(mineAssets, "neon"), []);
  });
});

describe("library cards", () => {
  const catalog = {
    userId: "me",
    items: [
      item({ slug: "giant-mushroom-tree", title: "Giant Mushroom Tree", shelf: PlayShelf.Assets }),
      item({ slug: "chitin-hut", authorId: "me", shelf: PlayShelf.Assets }),
    ],
  };
  const library = [
    libraryAsset({ id: "gen-mushroom-01", title: "Giant mushroom tree with a tall twisted stem" }),
    libraryAsset({ id: "gen-strider-02", title: "Silt strider", saved: true }),
    libraryAsset({
      id: "gen-hut-0003",
      title: "Chitin hut with a round door",
      shared: { projectId: "p1", slug: "chitin-hut", live: true },
    }),
    libraryAsset({ id: "gen-crowd-004", title: "Stadium crowd", kind: LibraryKind.Sound, saved: true }),
    libraryAsset({ id: "gen-nofile-05", title: "Lost file", fileUrl: null }),
    libraryAsset({ id: "gen-russian-6", title: "Пока горит", kind: LibraryKind.Image, thumbnailUrl: null }),
  ];
  const docs = mentionCorpus([{ name: "Giant Mushroom Tree", title: "Mine", coverUrl: null }], catalog, library);
  const fromLibrary = docs.filter((doc) => doc.origin === MentionOrigin.Library);

  it("each takeable library asset is your own asset card with its kind, marks and generation", () => {
    assert.deepEqual(
      fromLibrary.map((d) => [d.handle, d.kind, d.assetKind, d.own, d.generation, d.saved ?? false, d.shared ?? false]),
      [
        ["giant-mushroom-tree-3", "asset", "3d", true, "gen-mushroom-01", false, false],
        ["silt-strider", "asset", "3d", true, "gen-strider-02", true, false],
        ["chitin-hut", "asset", "3d", true, "gen-hut-0003", false, true],
        ["stadium-crowd", "asset", "sound", true, "gen-crowd-004", true, false],
        ["asset", "asset", "image", true, "gen-russian-6", false, false],
      ],
    );
    assert.equal(fromLibrary[0]?.coverUrl, "https://assets.genex.technology/thumbs/gen-mushroom-01.webp");
  });

  it("handles stay unique against the games and genex.games, and a shared page gives way to its library card", () => {
    const all = docs.map((doc) => doc.handle);
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual(all.slice(0, 2), ["giant-mushroom-tree", "giant-mushroom-tree-2"]);
    assert.ok(!docs.some((doc) => doc.origin === MentionOrigin.Genex && doc.slug === "chitin-hut"));
  });

  it("a community asset carries its kind too", () => {
    const community = mentionCorpus([], {
      userId: null,
      items: [item({ slug: "lamp", shelf: PlayShelf.Assets, assetKind: LibraryKind.Image })],
    });
    assert.equal(community[0]?.assetKind, LibraryKind.Image);
  });

  it("a library handle keeps a few words and never ends on a small one", () => {
    assert.equal(libraryHandle("Giant mushroom tree with a tall twisted stem"), "giant-mushroom-tree");
    assert.equal(libraryHandle("Iron street lantern on a post"), "iron-street-lantern");
    assert.equal(libraryHandle("A"), "a");
    assert.equal(libraryHandle("Пока горит"), "asset");
  });

  it("a library tag carries its generation to main", () => {
    const strider = fromLibrary[1];
    assert.ok(strider);
    const tag = mentionRef(strider);
    assert.equal(tag.origin, MentionOrigin.Library);
    assert.equal(tag.generation, "gen-strider-02");
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
