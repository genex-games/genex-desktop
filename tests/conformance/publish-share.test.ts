/**
 * Publish's line that shares the game's assets on Play when it goes live: it shows only to a
 * signed-in account for a game with an asset Genex made that is not on Play yet; it shares exactly
 * those files, each under the first line it was made from (else its file's name); its pictures are
 * the first three of them; and after the shares it says one thing: how many missed (the ones Try
 * again sends), else how many are on Play, or will be once genex.games has checked them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AssetLibraryState,
  type GameLibraryStates,
  LibraryKind,
  ShareMiss,
} from "../../src/shared/asset-library.ts";
import type { ProjectAsset } from "../../src/shared/game-assets.ts";
import {
  allMissed,
  NO_SHARES,
  retryItems,
  SHARE_THUMBS_MAX,
  ShareLine,
  shareItems,
  shareLine,
  shareLineShown,
  shareThumbs,
  tallyShares,
  closedBeforeShare,
  CelebrationStep,
  celebrationStep,
} from "../../src/renderer/panels/plugins/genex/publish-share.ts";
import { shareInBatches } from "../../src/shared/asset-library.ts";

const LIVE = { projectId: "p1", slug: "chitin-hut", live: true };

function state(file: string, over: Partial<AssetLibraryState> = {}): AssetLibraryState {
  return {
    file,
    generationId: `gen-${file.replace(/\W/g, "")}`,
    saved: false,
    shared: null,
    saveable: true,
    shareable: true,
    ...over,
  };
}

const states = (list: AssetLibraryState[], unread = false): GameLibraryStates => ({
  project: "snowball",
  states: list,
  unread,
});

function asset(file: string, over: Partial<ProjectAsset> = {}): ProjectAsset {
  return { file, kind: "model", bytes: 1, mtime: "2026-10-17T09:00:00.000Z", source: "genex", ...over } as ProjectAsset;
}

describe("Publish's share line: when it shows", () => {
  const game = states([
    state("assets/genex/a/mushroom.glb"),
    state("assets/genex/b/hut.glb", { shared: LIVE }),
    state("assets/blender/rock.glb", { shareable: false, saved: true }),
  ]);

  it("shows to a signed-in account for a game with an asset Genex made that is not on Play yet", () => {
    assert.equal(shareLineShown(true, game), true);
  });

  it("never shows signed out, before the states are read, or while the library could not be read", () => {
    assert.equal(shareLineShown(false, game), false);
    assert.equal(shareLineShown(true, null), false);
    assert.equal(shareLineShown(true, states(game.states, true)), false);
  });

  it("never shows when every asset Genex made is on Play already, or none was made by Genex", () => {
    assert.equal(
      shareLineShown(true, states([state("a.glb", { shared: LIVE }), state("b.glb", { shareable: false })])),
      false,
    );
    assert.equal(shareLineShown(true, states([])), false);
  });

  it("offers an asset again once its sharing was stopped", () => {
    assert.equal(shareLineShown(true, states([state("a.glb", { shared: { ...LIVE, live: false } })])), true);
  });
});

describe("Publish's share line: what it shares", () => {
  const game = states([
    state("assets/genex/a/giant_mushroom-tree.glb"),
    state("assets/genex/b/hut.glb", { shared: LIVE }),
    state("assets/genex/c/strider.glb"),
    state("assets/blender/rock.glb", { shareable: false }),
  ]);
  const assets = [
    asset("assets/genex/c/strider.glb", { prompt: "silt strider, a giant insect mount\nlow poly" }),
    asset("assets/genex/a/giant_mushroom-tree.glb"),
  ];

  it("shares only the files Genex made that are not on Play, each under the first line it was made from, else its name", () => {
    assert.deepEqual(shareItems(game, assets), [
      { file: "assets/genex/a/giant_mushroom-tree.glb", name: "Giant mushroom tree" },
      { file: "assets/genex/c/strider.glb", name: "Silt strider, a giant insect mount" },
    ]);
    assert.deepEqual(shareItems(null, assets), []);
  });

  it(`shows the first ${SHARE_THUMBS_MAX} of them, each with its generation and kind for its picture`, () => {
    const many = states(["a.glb", "b.png", "c.wav", "d.glb"].map((file) => state(file)));
    const kinds = [asset("b.png", { kind: "image" }), asset("c.wav", { kind: "audio" }), asset("a.glb")];
    assert.deepEqual(shareThumbs(many, kinds), [
      { file: "a.glb", generationId: "gen-aglb", kind: LibraryKind.Model },
      { file: "b.png", generationId: "gen-bpng", kind: LibraryKind.Image },
      { file: "c.wav", generationId: "gen-cwav", kind: LibraryKind.Sound },
    ]);
  });
});

describe("Publish's share line: how the shares went", () => {
  const items = [
    { file: "a.glb", name: "A" },
    { file: "b.glb", name: "B" },
    { file: "c.glb", name: "C" },
  ];

  it("says how many are on Play when every share went live", () => {
    const tally = tallyShares(items.map((item) => ({ file: item.file, shared: LIVE })));
    assert.deepEqual(shareLine(tally), { line: ShareLine.Shared, count: 3 });
  });

  it("counts a share genex.games is still checking as on its way, not as a miss", () => {
    const tally = tallyShares([
      { file: "a.glb", shared: LIVE },
      { file: "b.glb", miss: ShareMiss.Checking },
    ]);
    assert.deepEqual(shareLine(tally), { line: ShareLine.Checking, count: 2 });
  });

  it("says how many missed, and Try again sends only those, adding what it shares to the count", () => {
    const first = tallyShares([
      { file: "a.glb", shared: LIVE },
      { file: "b.glb", miss: ShareMiss.Refused, detail: "This can't go on Play." },
      { file: "c.glb", miss: ShareMiss.Failed },
    ]);
    assert.deepEqual(shareLine(first), { line: ShareLine.Missed, count: 2 });
    assert.deepEqual(
      retryItems(items, first).map((item) => item.file),
      ["b.glb", "c.glb"],
    );
    const again = tallyShares(
      [
        { file: "b.glb", miss: ShareMiss.Refused },
        { file: "c.glb", shared: LIVE },
      ],
      first,
    );
    assert.deepEqual(again, { shared: 2, checking: 0, missed: ["b.glb"] });
  });

  it("resets only when a celebration ends, so Share now keeps its line through the reads after it", () => {
    assert.equal(celebrationStep(false, true), CelebrationStep.Start);
    assert.equal(celebrationStep(true, true), CelebrationStep.Start, "the share still runs once: start is guarded");
    assert.equal(celebrationStep(true, false), CelebrationStep.Reset);
    assert.equal(celebrationStep(false, false), CelebrationStep.None, "a re-read after Share now clears nothing");
  });

  it("shows no ✓ line when every share was one no retry can fix", () => {
    const tally = tallyShares([{ file: "song.mp3", miss: ShareMiss.KindNotShareable }]);
    assert.deepEqual(shareLine(tally), { line: ShareLine.None, count: 0 });
  });

  it("remembers a share asked for but not run when Publish closed, and nothing else", () => {
    assert.equal(closedBeforeShare(true, false, 3), true);
    assert.equal(closedBeforeShare(true, true, 3), false, "it ran");
    assert.equal(closedBeforeShare(false, false, 3), false, "the switch was off");
    assert.equal(closedBeforeShare(true, false, 0), false, "nothing to share");
  });

  it("sends more than one call carries in runs, every file answered", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ file: `assets/${i}.glb`, name: `A${i}` }));
    const calls: number[] = [];
    const outcomes = await shareInBatches(async (run) => {
      calls.push(run.length);
      return run.map((item) => ({ file: item.file, shared: LIVE }));
    }, many);
    assert.deepEqual(calls, [50, 50, 20]);
    assert.equal(outcomes.length, 120);
  });

  it("leaves out a miss no retry can fix: no orange line and no Try again for it", () => {
    const tally = tallyShares([
      { file: "a.glb", shared: LIVE },
      { file: "song.mp3", miss: ShareMiss.KindNotShareable },
      { file: "drop.glb", miss: ShareMiss.NotShareable },
    ]);
    assert.deepEqual(shareLine(tally), { line: ShareLine.Shared, count: 1 });
    assert.deepEqual(retryItems(items, tally), []);
  });

  it("counts every file of a batch that got no answer as missed, keeping what went before", () => {
    const before = tallyShares([{ file: "a.glb", shared: LIVE }]);
    assert.deepEqual(allMissed(items.slice(1), before), { shared: 1, checking: 0, missed: ["b.glb", "c.glb"] });
    assert.deepEqual(allMissed(items), { ...NO_SHARES, missed: ["a.glb", "b.glb", "c.glb"] });
  });
});
