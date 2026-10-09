/**
 * The Assets canvas's arrangement — pure, so it is pinned here and not in a screenshot.
 *
 * What these tests protect is the promise the canvas makes to somebody looking for a file they
 * just made: the same ledger always draws the same canvas, the newest generation is at the top of
 * its source, and no two cards are ever drawn on top of each other.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CARD_IMAGE_H,
  CARD_W,
  COLUMNS,
  cardHeight,
  groupAssets,
  layoutAssets,
  sourceLabel,
} from "../../src/renderer/assets-layout.ts";
import { assetKind, type ProjectAsset } from "../../src/shared/game-assets.ts";
import { boundsOf, type Rect } from "../../src/renderer/run-graph.ts";

/** Two cards share pixels. */
const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function asset(file: string, over: Partial<ProjectAsset> = {}): ProjectAsset {
  return {
    file,
    kind: assetKind(file),
    bytes: 1024,
    mtime: "2026-09-18T10:00:00.000Z",
    source: "imported",
    ...over,
  };
}

describe("assetKind", () => {
  it("names a file by its extension, and says so honestly when it cannot", () => {
    assert.equal(assetKind("assets/genex/a/banner.PNG"), "image");
    assert.equal(assetKind("assets/tree.glb"), "model");
    assert.equal(assetKind("assets/theme.ogg"), "audio");
    assert.equal(assetKind("assets/intro.webm"), "video");
    assert.equal(assetKind("assets/level.bin"), "other");
    assert.equal(assetKind(""), "other");
  });
});

describe("sourceLabel", () => {
  it("gives the two the studio ships a name, and leaves any other plugin its id", () => {
    assert.equal(sourceLabel("genex"), "Genex");
    assert.equal(sourceLabel("blender"), "Blender");
    assert.equal(sourceLabel("imported"), "Your files");
    assert.equal(sourceLabel("soundsmith"), "soundsmith");
  });
});

describe("groupAssets", () => {
  it("puts the sources in a fixed order, whatever order the walk returned", () => {
    const groups = groupAssets([
      asset("assets/loose.png"),
      asset("assets/zebra/x.png", { source: "zebra", jobId: "z1" }),
      asset("assets/blender/tree.glb", { source: "blender", jobId: "tree" }),
      asset("assets/alpha/x.png", { source: "alpha", jobId: "a1" }),
      asset("assets/genex/x.png", { source: "genex", jobId: "g1" }),
    ]);
    assert.deepEqual(
      groups.map((group) => group.source),
      ["genex", "blender", "alpha", "zebra", "imported"],
    );
    // A plugin installed during a run must not be able to reshuffle the canvas above it.
    const reversed = groupAssets([
      asset("assets/genex/x.png", { source: "genex", jobId: "g1" }),
      asset("assets/alpha/x.png", { source: "alpha", jobId: "a1" }),
      asset("assets/blender/tree.glb", { source: "blender", jobId: "tree" }),
      asset("assets/zebra/x.png", { source: "zebra", jobId: "z1" }),
      asset("assets/loose.png"),
    ]);
    assert.deepEqual(
      reversed.map((group) => group.source),
      groups.map((group) => group.source),
    );
  });

  it("puts a source's newest job first, and a job that never said when it happened last", () => {
    const groups = groupAssets([
      asset("assets/genex/old.png", { source: "genex", jobId: "old", at: "2026-09-01T00:00:00.000Z" }),
      asset("assets/genex/new.png", { source: "genex", jobId: "new", at: "2026-09-18T00:00:00.000Z" }),
      asset("assets/genex/undated.png", { source: "genex", jobId: "undated" }),
      asset("assets/genex/mid.png", { source: "genex", jobId: "mid", at: "2026-09-10T00:00:00.000Z" }),
    ]);
    assert.deepEqual(
      groups[0]!.jobs.map((job) => job.jobId),
      ["new", "mid", "old", "undated"],
    );
  });

  it("keeps one job's files together, by path, and counts them", () => {
    const groups = groupAssets([
      asset("assets/genex/j/b.png", { source: "genex", jobId: "j" }),
      asset("assets/genex/j/a.png", { source: "genex", jobId: "j" }),
      asset("assets/loose-b.png"),
      asset("assets/loose-a.png"),
    ]);
    assert.equal(groups[0]!.jobs.length, 1);
    assert.deepEqual(
      groups[0]!.jobs[0]!.assets.map((entry) => entry.file),
      ["assets/genex/j/a.png", "assets/genex/j/b.png"],
    );
    assert.equal(groups[0]!.count, 2);
    // Files nobody claimed share one bucket — which is what "the folder" means.
    const loose = groups.find((group) => group.source === "imported")!;
    assert.equal(loose.jobs.length, 1);
    assert.equal(loose.jobs[0]!.jobId, null);
    assert.equal(loose.count, 2);
  });

  it("takes the plugin's own status word without paraphrasing it", () => {
    const groups = groupAssets([
      asset("assets/genex/j/a.png", { source: "genex", jobId: "j", pluginStatus: "downloaded" }),
    ]);
    assert.equal(groups[0]!.jobs[0]!.status, "downloaded");
  });

  it("draws a job that has started and delivered nothing, and drops it once its files land", () => {
    const pendingOnly = groupAssets([], [{ source: "genex", jobId: "genex:image", pluginStatus: "requested" }]);
    assert.equal(pendingOnly[0]!.jobs[0]!.pending, true);
    assert.equal(pendingOnly[0]!.count, 0, "a placeholder is not a file");
    const landed = groupAssets(
      [asset("assets/genex/j/a.png", { source: "genex", jobId: "genex:image" })],
      [{ source: "genex", jobId: "genex:image", pluginStatus: "requested" }],
    );
    assert.equal(landed[0]!.jobs.length, 1);
    assert.equal(landed[0]!.jobs[0]!.pending, undefined, "the real files replace the placeholder");
  });
});

describe("layoutAssets", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    asset(`assets/genex/j/p${String(i).padStart(2, "0")}.png`, { source: "genex", jobId: "j" }),
  );

  it("is deterministic: the same ledger draws the same canvas", () => {
    const a = layoutAssets(many);
    const b = layoutAssets([...many].reverse());
    assert.deepEqual(a.rects, b.rects);
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
  });

  it("wraps at five cards and starts the next row below the tallest of the last", () => {
    const layout = layoutAssets(many);
    const rows = new Map<number, number>();
    for (let i = 0; i < many.length; i += 1) {
      const rect = layout.rects[`asset:${many[i]!.file}`]!;
      rows.set(rect.y, (rows.get(rect.y) ?? 0) + 1);
    }
    assert.deepEqual([...rows.values()], [COLUMNS, COLUMNS, 2], "five to a row");
    const first = layout.rects[`asset:${many[0]!.file}`]!;
    const sixth = layout.rects[`asset:${many[5]!.file}`]!;
    assert.equal(sixth.x, first.x, "a new row starts at the left again");
    assert.ok(sixth.y >= first.y + first.h, "and below the row above it");
  });

  it("packs separate generations into the same row and reserves a full preview while pending", () => {
    const files = [
      asset("assets/a.glb", { source: "genex", jobId: "a", at: "2026-09-22" }),
      asset("assets/b.glb", { source: "genex", jobId: "b", at: "2026-09-21" }),
    ];
    const layout = layoutAssets(files, [{ source: "genex", jobId: "c", at: "2026-09-20" }]);
    const a = layout.rects["asset:assets/a.glb"]!,
      b = layout.rects["asset:assets/b.glb"]!,
      pending = layout.rects["pending:genex:c"]!;
    assert.equal(a.y, b.y);
    assert.equal(b.y, pending.y);
    assert.ok(b.x > a.x);
    assert.equal(pending.h, CARD_IMAGE_H);
    const delivered = layoutAssets([
      ...files,
      asset("assets/c.glb", { source: "genex", jobId: "c", at: "2026-09-20" }),
    ]);
    assert.deepEqual(delivered.rects["asset:assets/c.glb"], pending);
  });

  it("gives images, models and media room for recognizable previews", () => {
    const layout = layoutAssets([
      asset("assets/genex/j/a.png", { source: "genex", jobId: "j" }),
      asset("assets/genex/j/b.glb", { source: "genex", jobId: "j" }),
    ]);
    assert.equal(layout.rects["asset:assets/genex/j/a.png"]!.h, CARD_IMAGE_H);
    assert.equal(layout.rects["asset:assets/genex/j/b.glb"]!.h, CARD_IMAGE_H);
    assert.equal(layout.rects["asset:assets/genex/j/a.png"]!.w, CARD_W);
    assert.equal(cardHeight("image"), CARD_IMAGE_H);
    assert.equal(cardHeight("audio"), CARD_IMAGE_H);
    assert.equal(cardHeight("model"), CARD_IMAGE_H);
    assert.equal(cardHeight("video"), CARD_IMAGE_H);
  });

  it("never draws two cards on top of each other, across sources, jobs and kinds", () => {
    const layout = layoutAssets(
      [
        ...many,
        asset("assets/genex/k/one.glb", { source: "genex", jobId: "k", at: "2026-09-19T00:00:00.000Z" }),
        asset("assets/blender/tree.glb", { source: "blender", jobId: "tree" }),
        asset("assets/blender/rock.glb", { source: "blender", jobId: "rock" }),
        asset("assets/loose.wav"),
      ],
      [{ source: "genex", jobId: "genex:image" }],
    );
    const cards = Object.entries(layout.rects).filter(([id]) => id.startsWith("asset:") || id.startsWith("pending:"));
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        assert.equal(rectsOverlap(cards[i]![1], cards[j]![1]), false, `${cards[i]![0]} overlaps ${cards[j]![0]}`);
      }
    }
    // Groups are blocks stacked down the canvas; they do not overlap each other either.
    const groups = Object.entries(layout.rects).filter(([id]) => id.startsWith("group:"));
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        assert.equal(rectsOverlap(groups[i]![1], groups[j]![1]), false, `${groups[i]![0]} overlaps ${groups[j]![0]}`);
      }
    }
  });

  it("reports a canvas big enough to hold everything it laid out", () => {
    const layout = layoutAssets([...many, asset("assets/blender/tree.glb", { source: "blender", jobId: "tree" })]);
    const bounds = boundsOf(Object.values(layout.rects))!;
    assert.ok(bounds.x >= 0 && bounds.y >= 0, "nothing is drawn off the top or left");
    assert.ok(bounds.x + bounds.w <= layout.width, "and nothing past the right edge");
    assert.ok(bounds.y + bounds.h <= layout.height, "or the bottom");
  });

  it("draws nothing, and no empty bands, for a game with no assets", () => {
    const layout = layoutAssets([]);
    assert.deepEqual(layout.groups, []);
    assert.deepEqual(layout.rects, {});
    assert.equal(boundsOf(Object.values(layout.rects)), null);
  });
});
