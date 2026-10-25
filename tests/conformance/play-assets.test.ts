/**
 * Play's Assets shelf as square tiles: Mine always reads the person's library, Everyone reads the
 * Assets feed for every kind, the whole catalog for one kind (so a kind is never empty because a
 * first page had none) and a search when words are typed. Tiles keep only the chosen kind, a library
 * asset wears Shared while it is on Play (its cover opens that page) and Saved when saved, and Use
 * lists the person's games, the most recently opened first. The store reads the library page by page
 * for one kind and search at a time, drops an answer for a list a newer read replaced, keeps what it
 * has when a read fails, and reads the catalog once until it is stale or forced. A tile with no cover
 * shows an image's own file, or a picture drawn from a 3D file a few at a time and kept for the
 * session; a sound or a file off genex.games' hosts keeps the kind's glyph.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AssetScope,
  type LibraryAsset,
  LibraryFileMiss,
  LibraryKind,
  type LibraryPage,
} from "../../src/shared/asset-library.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import type { GenexCatalogItem } from "../../src/shared/mention-corpus.ts";
import { type PlayGame, PlayShelf } from "../../src/shared/play.ts";
import {
  ALL_ASSETS,
  addTargets,
  catalogTiles,
  EMPTY_LIBRARY,
  gameTiles,
  KindChoice,
  libraryTile,
  PictureFrom,
  TileSource,
  tilePicture,
  tileSource,
  WAVE_BARS,
  waveDrawing,
  withLibraryPage,
} from "../../src/renderer/play/asset-tiles.ts";
import { CardTag } from "../../src/renderer/asset-library-view.ts";
import { FeedStatus } from "../../src/renderer/play/play-model.ts";
import {
  MAX_PICTURE_TRIES,
  type ModelFile,
  PICTURE_RETRY_MS,
  PICTURES_AT_ONCE,
  PictureFileMissed,
  pictureFileBytes,
  pictureQueue,
  viewerFileOf,
} from "../../src/renderer/play/tile-pictures.ts";
import { SnapshotError } from "../../src/renderer/asset-snapshot.ts";
import { PreviewFailure } from "../../src/shared/asset-preview.ts";
import { assetViewChosen, createPlayStore, FEED_STALE_MS, initialPlay } from "../../src/renderer/state/play.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

function catalogItem(over: Partial<GenexCatalogItem> & { slug: string }): GenexCatalogItem {
  return {
    title: over.slug,
    description: "",
    shelf: PlayShelf.Assets,
    authorId: null,
    authorName: "Threejs Community",
    thumbnailUrl: null,
    playsCount: 0,
    remixable: true,
    assetKind: LibraryKind.Model,
    ...over,
  };
}

function game(over: Partial<PlayGame> & { slug: string }): PlayGame {
  return {
    id: over.slug,
    title: over.slug,
    description: "",
    coverUrl: null,
    clipUrl: null,
    multiplayer: false,
    plays: 0,
    online: null,
    author: { id: null, name: "Gab", imageUrl: null },
    remixable: false,
    assetKind: LibraryKind.Model,
    ...over,
  };
}

function asset(over: Partial<LibraryAsset> & { id: string }): LibraryAsset {
  return {
    kind: LibraryKind.Model,
    title: over.id,
    thumbnailUrl: null,
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

const keys = (tiles: readonly { key: string }[]): string[] => tiles.map((tile) => tile.key);

describe("Assets shelf: where the tiles come from", () => {
  it("reads Mine from the person's library whatever the kind or search", () => {
    for (const kind of [KindChoice.All, KindChoice.Sound])
      for (const query of ["", "crowd"])
        assert.equal(tileSource({ scope: AssetScope.Mine, kind }, query), TileSource.Library, `${kind} ${query}`);
  });

  it("reads Everyone from the feed for every kind, the whole catalog for one kind, and a search once words are typed", () => {
    assert.equal(tileSource(ALL_ASSETS, ""), TileSource.Feed);
    assert.equal(tileSource(ALL_ASSETS, "   "), TileSource.Feed, "blank words are no search");
    assert.equal(tileSource({ scope: AssetScope.Everyone, kind: KindChoice.Sound }, ""), TileSource.Catalog);
    assert.equal(tileSource({ scope: AssetScope.Everyone, kind: KindChoice.Sound }, "crowd"), TileSource.Search);
    assert.equal(tileSource(ALL_ASSETS, "crowd"), TileSource.Search);
  });

  it("opens on everyone's assets of every kind, and a switcher's same choice keeps the state", () => {
    const state = initialPlay();
    assert.deepEqual(state.assetView, ALL_ASSETS);
    assert.equal(assetViewChosen(state, { kind: KindChoice.All }), state);
    const mine = assetViewChosen(state, { scope: AssetScope.Mine });
    assert.deepEqual(mine.assetView, { scope: AssetScope.Mine, kind: KindChoice.All });
    assert.deepEqual(assetViewChosen(mine, { kind: KindChoice.Image }).assetView, {
      scope: AssetScope.Mine,
      kind: KindChoice.Image,
    });
  });
});

describe("Assets shelf: tiles", () => {
  const items = [
    catalogItem({ slug: "stone-fireplace" }),
    catalogItem({ slug: "crowd-cheer", assetKind: LibraryKind.Sound, authorName: "Rabneba" }),
    catalogItem({ slug: "mossy-wall", assetKind: LibraryKind.Image }),
    catalogItem({ slug: "lost-cathedral", shelf: PlayShelf.Games, assetKind: null }),
    catalogItem({ slug: "physics-sandbox", shelf: PlayShelf.Tools, assetKind: null }),
  ];

  it("keeps only the catalog's assets of the chosen kind, every asset for All, never a game or a tool", () => {
    assert.deepEqual(keys(catalogTiles(items, KindChoice.Sound)), ["crowd-cheer"]);
    assert.deepEqual(keys(catalogTiles(items, KindChoice.Video)), []);
    assert.deepEqual(keys(catalogTiles(items, KindChoice.All)), ["stone-fireplace", "crowd-cheer", "mossy-wall"]);
  });

  it("draws a shared asset with who made it, adds it by its slug and opens its page", () => {
    const [tile] = catalogTiles(items, KindChoice.Sound);
    assert.deepEqual(tile, {
      key: "crowd-cheer",
      title: "crowd-cheer",
      author: "Rabneba",
      coverUrl: null,
      kind: LibraryKind.Sound,
      fileUrl: null,
      fileKind: null,
      fileFormat: null,
      source: { slug: "crowd-cheer" },
      slug: "crowd-cheer",
      tag: null,
    });
  });

  it("filters a page or a search by kind, and a card with no named maker has no author line", () => {
    const games = [
      game({ slug: "fireplace" }),
      game({ slug: "cheer", assetKind: LibraryKind.Sound, author: { id: null, name: "", imageUrl: null } }),
    ];
    assert.deepEqual(keys(gameTiles(games, KindChoice.All)), ["fireplace", "cheer"]);
    const [cheer] = gameTiles(games, KindChoice.Sound);
    assert.equal(cheer?.author, null);
    assert.deepEqual(cheer?.source, { slug: "cheer" });
  });

  it("tags a library asset Shared while it is on Play, else Saved when saved, else nothing", () => {
    const live = { projectId: "p1", slug: "chitin-hut", live: true };
    const shared = libraryTile(asset({ id: "gen-hut-0003", shared: live, saved: true }));
    assert.equal(shared.tag, CardTag.Shared);
    assert.equal(shared.slug, "chitin-hut", "a shared asset's cover opens its page on Play");
    const stopped = libraryTile(asset({ id: "gen-old-0007", shared: { ...live, live: false }, saved: true }));
    assert.equal(stopped.tag, CardTag.Saved);
    assert.equal(stopped.slug, null, "an asset taken off Play has no page to open");
    const plain = libraryTile(asset({ id: "gen-mush-0001" }));
    assert.equal(plain.tag, null);
    assert.equal(plain.author, null, "the person's own asset names nobody");
    assert.deepEqual(plain.source, { generationId: "gen-mush-0001" });
    assert.equal(plain.fileUrl, "https://assets.genex.technology/generations/gen-mush-0001/file.glb");
  });

  it("offers the person's games for Use, the most recently opened first, leaving the list it was given", () => {
    const games = [
      { name: "a", title: "A", createdAt: "2026-10-01", lastOpenedAt: "2026-10-10" },
      { name: "b", title: "B", createdAt: "2026-10-12" },
      { name: "c", title: "C", createdAt: "2026-09-01", lastOpenedAt: "2026-10-16" },
    ] as unknown as GameProject[];
    assert.deepEqual(
      addTargets(games).map((g) => g.name),
      ["c", "b", "a"],
    );
    assert.deepEqual(
      games.map((g) => g.name),
      ["a", "b", "c"],
    );
  });

  it("draws a sound the same way each time, louder in the middle, every bar within the tile", () => {
    const wave = waveDrawing("crowd-cheer");
    assert.equal(wave.length, WAVE_BARS);
    assert.deepEqual(waveDrawing("crowd-cheer"), wave);
    assert.notDeepEqual(waveDrawing("rain-loop"), wave);
    assert.ok(
      wave.every((bar) => bar >= 0.18 && bar <= 1),
      wave.join(","),
    );
    const middle = wave[Math.floor(WAVE_BARS / 2)] ?? 0;
    assert.ok(middle > (wave[0] ?? 1), "the middle is louder than the edge");
  });
});

const FILES = "https://assets.genex.technology/generations";

describe("Assets shelf: a tile's picture", () => {
  it("shows the cover when there is one, whatever the kind", () => {
    const cover = "https://assets.genex.technology/thumb.webp";
    for (const kind of [LibraryKind.Model, LibraryKind.Image, LibraryKind.Video]) {
      const tile = libraryTile(asset({ id: "gen-cover-0001", kind, thumbnailUrl: cover }));
      assert.deepEqual(tilePicture(tile), { from: PictureFrom.Image, url: cover }, kind);
    }
  });

  it("shows an image with no cover as its own file", () => {
    const file = `${FILES}/gen-dusk-0007/image-main`;
    const tile = libraryTile(
      asset({ id: "gen-dusk-0007", kind: LibraryKind.Image, fileUrl: file, fileKind: LibraryKind.Image }),
    );
    assert.deepEqual(tilePicture(tile), { from: PictureFrom.Image, url: file });
  });

  it("shows the file a 3D asset keeps as a picture when that file is a picture, never reading it as a model", () => {
    // Its model is off genex.games' hosts, so the file the library keeps for it is its preview picture.
    const file = `${FILES}/gen-sword-0010/preview.png`;
    const tile = libraryTile(asset({ id: "gen-sword-0010", fileUrl: file, fileKind: LibraryKind.Image }));
    assert.deepEqual(tilePicture(tile), { from: PictureFrom.Image, url: file });
    const unknown = libraryTile(
      asset({ id: "gen-sword-0011", fileUrl: `${FILES}/gen-sword-0011/extra`, fileKind: null }),
    );
    assert.equal(tilePicture(unknown), null, "a file nothing says is a model or a picture keeps the glyph");
  });

  it("draws a 3D asset with no cover from its model file", () => {
    const file = `${FILES}/gen-sword-0008/model-glb`;
    const tile = libraryTile(asset({ id: "gen-sword-0008", fileUrl: file }));
    assert.deepEqual(tilePicture(tile), { from: PictureFrom.Model, url: file, format: "glb" });
  });

  it("draws a 3D asset whose address names no format by the format main decided", () => {
    const file = `${FILES}/gen-knight-0012/original`;
    const tile = libraryTile(
      asset({ id: "gen-knight-0012", fileUrl: file, fileKind: LibraryKind.Model, fileFormat: "fbx" }),
    );
    assert.deepEqual(tilePicture(tile), { from: PictureFrom.Model, url: file, format: "fbx" });
  });

  it("keeps the glyph for a sound, a video, a tile that knows no file, and a file off genex.games' hosts", () => {
    const bare = (over: Partial<LibraryAsset>) => tilePicture(libraryTile(asset({ id: "gen-bare-0009", ...over })));
    assert.equal(bare({ kind: LibraryKind.Sound, fileUrl: `${FILES}/x/audio-sfx`, fileKind: LibraryKind.Sound }), null);
    assert.equal(bare({ kind: LibraryKind.Video, fileUrl: `${FILES}/x/video-mp4`, fileKind: LibraryKind.Video }), null);
    assert.equal(bare({ fileUrl: null }), null);
    for (const fileUrl of [
      "https://tripo-data.rg1.data.tripo3d.com/x/model.glb",
      "http://assets.genex.technology/x/model.glb",
      "https://assets.genex.technology.evil.example/x/model.glb",
      "data:image/png;base64,AAAA",
    ]) {
      assert.equal(bare({ fileUrl }), null, fileUrl);
      assert.equal(bare({ kind: LibraryKind.Image, fileUrl, fileKind: LibraryKind.Image }), null, fileUrl);
    }
    const [noCover] = catalogTiles([catalogItem({ slug: "no-cover" })], KindChoice.All);
    assert.ok(noCover);
    assert.equal(tilePicture(noCover), null, "a shared asset with no cover knows no file");
  });

  it("reads a model file by the format main decided, else its address's model extension, else as a GLB", () => {
    const read = (url: string, format: string | null = null) => viewerFileOf({ url: `${FILES}/gen-a/${url}`, format });
    assert.equal(read("original", "fbx"), "model.fbx", "a non-GLB model whose address names no format");
    assert.equal(read("original", "gltf"), "model.gltf");
    assert.equal(read("original", "OBJ"), "model.obj");
    assert.equal(read("model-glb"), "model.glb");
    assert.equal(read("knight.fbx"), "model.fbx");
    assert.equal(read("knight.GLB?v=2"), "model.glb");
    assert.equal(read("notes.txt"), "model.glb");
    for (const format of ["png", "blend", "../x", "constructor", ""])
      assert.equal(read("original", format), "model.glb", format);
  });
});

/** A model file the queue is asked for, by its address alone. */
const model = (url: string): ModelFile => ({ url, format: null });

/** A draw the test finishes by hand, each start recorded. */
function handDraws() {
  const started: string[] = [];
  const pending = new Map<string, { resolve: (picture: string) => void; reject: (error: Error) => void }>();
  const draw = ({ url }: ModelFile) =>
    new Promise<string>((resolve, reject) => {
      started.push(url);
      pending.set(url, { resolve, reject });
    });
  const settle = async (url: string, picture: string | Error): Promise<void> => {
    const hand = pending.get(url);
    assert.ok(hand, `${url} was drawing`);
    if (picture instanceof Error) hand.reject(picture);
    else hand.resolve(picture);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { started, draw, settle };
}

describe("Assets shelf: pictures drawn from 3D files", () => {
  const live = () => new AbortController().signal;

  it("draws a few at a time; the rest wait their turn in order", async () => {
    const hand = handDraws();
    const queue = pictureQueue(hand.draw);
    const urls = ["a", "b", "c", "d"];
    const asked = urls.map((url) => queue.request(model(url), live()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(PICTURES_AT_ONCE, 2);
    assert.deepEqual(hand.started, ["a", "b"]);
    await hand.settle("a", "pic-a");
    assert.deepEqual(hand.started, ["a", "b", "c"]);
    await hand.settle("b", "pic-b");
    await hand.settle("c", "pic-c");
    await hand.settle("d", "pic-d");
    assert.deepEqual(await Promise.all(asked), ["pic-a", "pic-b", "pic-c", "pic-d"]);
  });

  it("keeps a drawn picture for the session: asking again never draws again", async () => {
    const hand = handDraws();
    const queue = pictureQueue(hand.draw);
    const first = queue.request(model("a"), live());
    const again = queue.request(model("a"), live());
    await new Promise((resolve) => setImmediate(resolve));
    await hand.settle("a", "pic-a");
    assert.equal(await first, "pic-a");
    assert.equal(await again, "pic-a");
    assert.equal(queue.drawn("a"), "pic-a");
    assert.equal(await queue.request(model("a"), live()), "pic-a");
    assert.deepEqual(hand.started, ["a"]);
  });

  it("never draws a picture whose tile left the screen before its turn, and frees its place", async () => {
    const hand = handDraws();
    const queue = pictureQueue(hand.draw);
    void queue.request(model("a"), live());
    void queue.request(model("b"), live());
    const leaving = new AbortController();
    const left = queue.request(model("c"), leaving.signal);
    void queue.request(model("d"), live());
    leaving.abort();
    await assert.rejects(left);
    await hand.settle("a", "pic-a");
    assert.deepEqual(hand.started, ["a", "b", "d"]);
    assert.equal(queue.drawn("c"), undefined);
  });

  it("forgets the oldest picture past what it keeps", async () => {
    const queue = pictureQueue(async ({ url }) => `pic-${url}`, { kept: 2 });
    for (const url of ["a", "b", "c"]) await queue.request(model(url), live());
    assert.equal(queue.drawn("a"), undefined);
    assert.equal(queue.drawn("c"), "pic-c");
  });
});

describe("Assets shelf: a picture that could not be drawn", () => {
  const live = () => new AbortController().signal;

  for (const [label, error] of [
    ["it is not a model the viewer reads", new SnapshotError(PreviewFailure.File, new Error("not a GLB"))],
    ["main refused it as over the cap", new PictureFileMissed(LibraryFileMiss.TooLarge)],
    ["genex.games refused it (a 4xx)", new PictureFileMissed(LibraryFileMiss.Refused)],
  ] as const) {
    it(`tries a file only once, however long the session runs, when ${label}`, async () => {
      const hand = handDraws();
      const clock = { at: 0 };
      const queue = pictureQueue(hand.draw, { now: () => clock.at });
      const failed = assert.rejects(queue.request(model("broken"), live()));
      await new Promise((resolve) => setImmediate(resolve));
      await hand.settle("broken", error);
      await failed;
      clock.at += 100 * PICTURE_RETRY_MS;
      const again = assert.rejects(queue.request(model("broken"), live()));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(hand.started, ["broken"], "never drawn again");
      await again;
    });
  }

  for (const [label, error] of [
    ["main could not read it for now (offline, a timeout, a 5xx)", new PictureFileMissed(LibraryFileMiss.Unavailable)],
    ["something else went wrong on the way", new Error("structured clone failed")],
    ["the graphics context was lost", new SnapshotError(PreviewFailure.Interrupted, new Error("context lost"))],
    ["decoding ran out of time", new SnapshotError(PreviewFailure.Interrupted, new Error("timed out"))],
  ] as const) {
    it(`draws again, after a short rest, a picture whose draw failed because ${label}`, async () => {
      const hand = handDraws();
      const clock = { at: 0 };
      const queue = pictureQueue(hand.draw, { now: () => clock.at });
      const failed = assert.rejects(queue.request(model("a"), live()));
      await new Promise((resolve) => setImmediate(resolve));
      await hand.settle("a", error);
      await failed;
      clock.at += PICTURE_RETRY_MS - 1;
      await assert.rejects(queue.request(model("a"), live()), "not again while it rests");
      assert.deepEqual(hand.started, ["a"]);
      clock.at += 1;
      const again = queue.request(model("a"), live());
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(hand.started, ["a", "a"], "the tile next on screen asks again");
      await hand.settle("a", "pic-a");
      assert.equal(await again, "pic-a");
      assert.equal(queue.drawn("a"), "pic-a");
    });
  }
});

describe("Assets shelf: a picture that keeps failing, and main's answer", () => {
  const live = () => new AbortController().signal;

  it(`stops trying a file whose draw failed ${MAX_PICTURE_TRIES} times for reasons that may pass`, async () => {
    const hand = handDraws();
    const clock = { at: 0 };
    const queue = pictureQueue(hand.draw, { now: () => clock.at });
    for (let tried = 1; tried <= MAX_PICTURE_TRIES; tried += 1) {
      const failed = assert.rejects(queue.request(model("a"), live()));
      await new Promise((resolve) => setImmediate(resolve));
      await hand.settle("a", new Error("the 3D loader gave up"));
      await failed;
      clock.at += PICTURE_RETRY_MS;
    }
    assert.equal(hand.started.length, MAX_PICTURE_TRIES);
    const again = assert.rejects(queue.request(model("a"), live()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hand.started.length, MAX_PICTURE_TRIES, "remembered as failed for the session");
    await again;
  });

  it("turns main's answer into the file's bytes, or into the refusal the queue reads", async () => {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
    assert.equal(pictureFileBytes({ bytes }), bytes);
    for (const miss of Object.values(LibraryFileMiss)) {
      assert.throws(
        () => pictureFileBytes({ miss }),
        (error: unknown) => error instanceof PictureFileMissed && error.miss === miss,
        miss,
      );
    }
    // Through the queue: a refusal for the file itself is never asked again; one that may pass is.
    const clock = { at: 0 };
    const answers = new Map([
      ["big", { miss: LibraryFileMiss.TooLarge }],
      ["gone", { miss: LibraryFileMiss.Refused }],
      ["busy", { miss: LibraryFileMiss.Unavailable }],
    ]);
    const asked: string[] = [];
    const queue = pictureQueue(
      async ({ url }) => {
        asked.push(url);
        pictureFileBytes(answers.get(url) ?? { bytes });
        return `pic-${url}`;
      },
      { now: () => clock.at },
    );
    for (const url of answers.keys()) await assert.rejects(queue.request(model(url), live()));
    clock.at += PICTURE_RETRY_MS;
    for (const url of answers.keys()) await assert.rejects(queue.request(model(url), live()));
    assert.deepEqual(asked, ["big", "gone", "busy", "busy"]);
  });
});

describe("Assets shelf: the person's library, page by page", () => {
  const key = { kind: KindChoice.All, query: "" };
  const page = (assets: LibraryAsset[], nextCursor: string | null = null): LibraryPage => ({ assets, nextCursor });

  it("replaces the list with a first page under its key, and adds only the assets a further page does not have", () => {
    const first = withLibraryPage(
      EMPTY_LIBRARY,
      { kind: KindChoice.Sound, query: " crowd " },
      page([asset({ id: "gen-a-00001" })], "gen-a-00001"),
      false,
      5,
    );
    assert.equal(first.status, FeedStatus.Ready);
    assert.equal(first.kind, KindChoice.Sound);
    assert.equal(first.query, "crowd");
    assert.equal(first.at, 5);
    const more = withLibraryPage(
      first,
      key,
      page([asset({ id: "gen-a-00001" }), asset({ id: "gen-b-00002" })]),
      true,
      9,
    );
    assert.deepEqual(
      more.assets.map((a) => a.id),
      ["gen-a-00001", "gen-b-00002"],
    );
    assert.equal(more.nextCursor, null);
    assert.equal(more.at, 5, "a further page keeps when the list was first read");
  });

  it("reads the kind and words asked, then the page after the last one's cursor", async () => {
    const fake = fakeStudioApi();
    const pages = [page([asset({ id: "gen-a-00001" })], "gen-a-00001"), page([asset({ id: "gen-b-00002" })])];
    fake.stub("assetLibrary", async () => pages.shift() ?? page([]));
    const play = createPlayStore(fake.api, null, () => 1_000);
    const sounds = { kind: KindChoice.Sound, query: "crowd" };
    await play.loadLibrary(sounds);
    await play.loadLibrary(sounds, { more: true });
    assert.deepEqual(fake.callsOf("assetLibrary"), [
      [{ kind: LibraryKind.Sound, query: "crowd" }],
      [{ kind: LibraryKind.Sound, query: "crowd", before: "gen-a-00001" }],
    ]);
    assert.deepEqual(
      play.getState().library.assets.map((a) => a.id),
      ["gen-a-00001", "gen-b-00002"],
    );
    await play.loadLibrary(sounds, { more: true });
    assert.equal(fake.callsOf("assetLibrary").length, 2, "no next page past the last");
  });

  it("asks every kind with no filter, reads a fresh list once, and again once stale or forced", async () => {
    const fake = fakeStudioApi();
    fake.stub("assetLibrary", async () => page([asset({ id: "gen-a-00001" })]));
    let now = 1_000;
    const play = createPlayStore(fake.api, null, () => now);
    await play.loadLibrary(key);
    await play.loadLibrary(key);
    assert.deepEqual(fake.callsOf("assetLibrary"), [[{}]]);
    await play.loadLibrary(key, { force: true });
    now += FEED_STALE_MS;
    await play.loadLibrary(key);
    assert.equal(fake.callsOf("assetLibrary").length, 3);
  });

  it("drops the answer for a list a newer read replaced", async () => {
    const fake = fakeStudioApi();
    const answers: Array<(page: LibraryPage) => void> = [];
    fake.stub("assetLibrary", () => new Promise<LibraryPage>((resolve) => answers.push(resolve)));
    const play = createPlayStore(fake.api, null, () => 1_000);
    const all = play.loadLibrary(key);
    const sounds = play.loadLibrary({ kind: KindChoice.Sound, query: "" });
    answers[1]?.(page([asset({ id: "gen-snd-0001", kind: LibraryKind.Sound })]));
    await sounds;
    answers[0]?.(page([asset({ id: "gen-old-0001" })]));
    await all;
    const library = play.getState().library;
    assert.equal(library.kind, KindChoice.Sound);
    assert.deepEqual(
      library.assets.map((a) => a.id),
      ["gen-snd-0001"],
    );
  });

  it("shows the list asked for last when it comes back to one still on its way", async () => {
    const fake = fakeStudioApi();
    const answers: Array<(page: LibraryPage) => void> = [];
    fake.stub("assetLibrary", () => new Promise<LibraryPage>((resolve) => answers.push(resolve)));
    const play = createPlayStore(fake.api, null, () => 1_000);
    const sounds = { kind: KindChoice.Sound, query: "" };
    const all = play.loadLibrary(key);
    const sound = play.loadLibrary(sounds);
    const back = play.loadLibrary(key);
    answers[1]?.(page([asset({ id: "gen-snd-0001", kind: LibraryKind.Sound })]));
    answers[0]?.(page([asset({ id: "gen-all-0001" })]));
    await Promise.all([all, sound, back]);
    const library = play.getState().library;
    assert.equal(library.kind, KindChoice.All);
    assert.equal(library.status, FeedStatus.Ready);
    assert.deepEqual(
      library.assets.map((a) => a.id),
      ["gen-all-0001"],
    );
  });

  it("says an empty list failed, keeps a list's assets when a read fails, and says a further page failed", async () => {
    const fake = fakeStudioApi();
    let fail = true;
    fake.stub("assetLibrary", async () => {
      if (fail) throw new Error("offline");
      return page([asset({ id: "gen-a-00001" })], "gen-a-00001");
    });
    const play = createPlayStore(fake.api, null, () => 1_000);
    await play.loadLibrary(key);
    assert.equal(play.getState().library.status, FeedStatus.Failed);
    fail = false;
    await play.loadLibrary(key, { force: true });
    fail = true;
    await play.loadLibrary(key, { force: true });
    assert.equal(play.getState().library.status, FeedStatus.Ready);
    assert.equal(play.getState().library.assets.length, 1);
    await play.loadLibrary(key, { more: true });
    assert.equal(play.getState().library.moreFailed, true);
    assert.equal(play.getState().library.assets.length, 1);
  });
});

describe("Assets shelf: the whole catalog for the kind switcher", () => {
  it("reads it once while fresh, and says it failed until a forced read brings it", async () => {
    const fake = fakeStudioApi();
    let fail = true;
    fake.stub("playCatalog", async () => {
      if (fail) throw new Error("offline");
      return [catalogItem({ slug: "stone-fireplace" })];
    });
    const play = createPlayStore(fake.api, null, () => 1_000);
    await play.loadAssetCatalog();
    assert.equal(play.getState().assetCatalog.status, FeedStatus.Failed);
    fail = false;
    await play.loadAssetCatalog({ force: true });
    await play.loadAssetCatalog();
    assert.equal(play.getState().assetCatalog.status, FeedStatus.Ready);
    assert.deepEqual(
      play.getState().assetCatalog.items.map((item) => item.slug),
      ["stone-fireplace"],
    );
    assert.equal(fake.callsOf("playCatalog").length, 2);
  });
});
