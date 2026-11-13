/**
 * The Assets canvas's tabs and sort order: which cards a tab keeps, how many each tab counts, and
 * where a chosen order puts them. Pure, so it is pinned here and not in a screenshot.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AssetOrder,
  AssetTab,
  assetsOfTab,
  cardedAssets,
  tabCounts,
  waitingOfTab,
} from "../../src/renderer/assets-filter.ts";
import { groupAssets, layoutAssets } from "../../src/renderer/assets-layout.ts";
import { type MakingJob, MakingKind, MakingPhase } from "../../src/shared/asset-making.ts";
import { assetKind, type ProjectAsset } from "../../src/shared/game-assets.ts";

function asset(file: string, over: Partial<ProjectAsset> = {}): ProjectAsset {
  return { file, kind: assetKind(file), bytes: 1024, mtime: "2026-09-18T10:00:00.000Z", source: "imported", ...over };
}

const waitingJob = (jobId: string, kind?: MakingKind): MakingJob => ({
  source: "genex",
  jobId,
  phase: MakingPhase.Making,
  ...(kind ? { kind } : {}),
});

const GAME = [
  asset("assets/knight.glb"),
  asset("assets/tree.gltf"),
  asset("assets/cover.png"),
  asset("assets/theme.ogg"),
  asset("assets/intro.webm"),
  asset("assets/level.bin"),
];

describe("the Assets tabs", () => {
  it("count every file under All and each media kind under its own tab", () => {
    assert.deepEqual(tabCounts(GAME), {
      [AssetTab.All]: 6,
      [AssetTab.Models]: 2,
      [AssetTab.Images]: 1,
      [AssetTab.Sounds]: 1,
      [AssetTab.Video]: 1,
    });
    assert.deepEqual(tabCounts([]), {
      [AssetTab.All]: 0,
      [AssetTab.Models]: 0,
      [AssetTab.Images]: 0,
      [AssetTab.Sounds]: 0,
      [AssetTab.Video]: 0,
    });
  });

  it("keep a tab's own kind, in the order given, and everything under All", () => {
    assert.equal(assetsOfTab(GAME, AssetTab.All), GAME, "All hands the same list back");
    assert.deepEqual(
      assetsOfTab(GAME, AssetTab.Models).map((entry) => entry.file),
      ["assets/knight.glb", "assets/tree.gltf"],
    );
    assert.deepEqual(
      assetsOfTab(GAME, AssetTab.Sounds).map((entry) => entry.file),
      ["assets/theme.ogg"],
    );
    assert.deepEqual(assetsOfTab([asset("assets/level.bin")], AssetTab.Video), []);
  });

  it("keep a job still on its way under the tab its result will land in", () => {
    const jobs = [
      waitingJob("m", MakingKind.RiggedModel),
      waitingJob("a", MakingKind.Animation),
      waitingJob("t", MakingKind.Texture),
      waitingJob("v", MakingKind.Voice),
      waitingJob("c", MakingKind.Video),
      waitingJob("unknown"),
    ];
    const ids = (tab: AssetTab) => waitingOfTab(jobs, tab).map((job) => job.jobId);
    assert.equal(waitingOfTab(jobs, AssetTab.All), jobs);
    assert.deepEqual(ids(AssetTab.Models), ["m", "a"]);
    assert.deepEqual(ids(AssetTab.Images), ["t"]);
    assert.deepEqual(ids(AssetTab.Sounds), ["v"]);
    assert.deepEqual(ids(AssetTab.Video), ["c"]);
  });
});

describe("the files that get a card", () => {
  const knight = asset("assets/knight.glb");
  const walk = asset("assets/knight-walk.glb");
  const tail = asset("assets/tail-wag.glb");
  const cover = asset("assets/cover.png");
  const game = [knight, walk, tail, cover];

  it("are every file while the models' headers are still being read", () => {
    assert.deepEqual(cardedAssets(game, null), game);
  });

  it("lose the animation files folded into a model once the headers are read", () => {
    const folded = {
      clipsOf: new Map([[knight.file, [walk.file]]]),
      loose: [tail.file],
      motions: new Set([walk.file, tail.file]),
    };
    assert.deepEqual(cardedAssets(game, folded), [knight, tail, cover]);
  });
});

describe("the Assets sort order", () => {
  const files = [
    asset("assets/genex/new/zebra.png", { source: "genex", jobId: "new", at: "2026-09-18T00:00:00.000Z", bytes: 10 }),
    asset("assets/genex/old/Apple.png", { source: "genex", jobId: "old", at: "2026-09-01T00:00:00.000Z", bytes: 30 }),
    asset("assets/genex/old/mango.png", { source: "genex", jobId: "old", at: "2026-09-01T00:00:00.000Z", bytes: 20 }),
    asset("assets/loose.png", { bytes: 5 }),
  ];
  const drawn = (order?: AssetOrder) =>
    groupAssets(files, [], order).map((group) => group.jobs.flatMap((job) => job.assets.map((entry) => entry.file)));

  it("is newest job first unless another is asked for", () => {
    assert.deepEqual(drawn(), drawn(AssetOrder.Newest));
    assert.deepEqual(drawn()[0], [
      "assets/genex/new/zebra.png",
      "assets/genex/old/Apple.png",
      "assets/genex/old/mango.png",
    ]);
  });

  it("by name runs through a source's files by file name, whatever job made them", () => {
    assert.deepEqual(drawn(AssetOrder.Name), [
      ["assets/genex/old/Apple.png", "assets/genex/old/mango.png", "assets/genex/new/zebra.png"],
      ["assets/loose.png"],
    ]);
  });

  it("by size puts a source's largest file first", () => {
    assert.deepEqual(drawn(AssetOrder.Size)[0], [
      "assets/genex/old/Apple.png",
      "assets/genex/old/mango.png",
      "assets/genex/new/zebra.png",
    ]);
  });

  it("keeps the sources in their fixed order and a waiting job ahead of the sorted files", () => {
    const groups = groupAssets(files, [waitingJob("w")], AssetOrder.Name);
    assert.deepEqual(
      groups.map((group) => group.source),
      ["genex", "imported"],
    );
    assert.equal(groups[0]?.jobs[0]?.waiting?.jobId, "w");
    assert.equal(groups[0]?.count, 3);
  });

  it("places a card for every file in any order, none on top of another", () => {
    for (const order of Object.values(AssetOrder)) {
      const { rects } = layoutAssets(files, [], undefined, order);
      const cards = files.map((entry) => rects[`asset:${entry.file}`]);
      assert.ok(cards.every(Boolean), `${order}: every file has a card`);
      assert.equal(new Set(cards.map((rect) => `${rect?.x},${rect?.y}`)).size, files.length, `${order}: no overlap`);
    }
  });
});
