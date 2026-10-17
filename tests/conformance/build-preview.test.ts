import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { latestBuildPreview } from "../../src/substrate/build-preview.ts";
test("saved capture lookup chooses newest capture, prefers default camera, and contains paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-preview-"));
  try {
    const dir = path.join(root, "run_x/facet_river/self/iter_001");
    await mkdir(dir, { recursive: true });
    for (const name of ["c1_default.jpg", "c2_bridge.jpg", "c2_default.jpg"])
      await writeFile(path.join(dir, name), "fixture");
    const request = { runId: "run_x", facetId: "river", iteration: 1 };
    const frame = await latestBuildPreview(root, request);
    assert.equal(path.basename(frame!.path), "c2_default.jpg");
    assert.ok(Number.isFinite(Date.parse(frame!.capturedAt)));
    assert.equal(await latestBuildPreview(root, { ...request, runId: "../escape" }), null);
    assert.equal(await latestBuildPreview(root, { ...request, facetId: "../escape" }), null);
    assert.equal(await latestBuildPreview(root, { ...request, iteration: -1 }), null);
    assert.equal(await latestBuildPreview(root, { ...request, iteration: 2 }), null);
    const outside = await mkdtemp(path.join(os.tmpdir(), "preview-outside-"));
    try {
      await writeFile(path.join(outside, "frame.jpg"), "outside");
      await symlink(path.join(outside, "frame.jpg"), path.join(dir, "c9_default.jpg"));
      assert.equal(path.basename((await latestBuildPreview(root, request))!.path), "c2_default.jpg");
      await symlink(outside, path.join(root, "escaped"));
      assert.equal(await latestBuildPreview(root, { ...request, runId: "escaped" }), null);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a builder that only played through its computer session still has a picture: its newest frame", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-preview-"));
  try {
    const dir = path.join(root, "run_x/facet_enemy/self/iter_001");
    await mkdir(dir, { recursive: true });
    const request = { runId: "run_x", facetId: "enemy", iteration: 1 };
    // Frames the computer session saved (`s<n>_<what>.jpg`), the newest written last.
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 0, 0, seconds));
    for (const [name, seconds] of [
      ["s1_screen.jpg", 1],
      ["s2_after-key.jpg", 2],
      ["trace.jsonl", 9],
    ] as const) {
      await writeFile(path.join(dir, name), "fixture");
      await utimes(path.join(dir, name), at(seconds), at(seconds));
    }
    assert.equal(path.basename((await latestBuildPreview(root, request))!.path), "s2_after-key.jpg");
    // A capture and a session frame in one folder: whichever was saved last is the picture.
    await writeFile(path.join(dir, "c1_default.jpg"), "fixture");
    await utimes(path.join(dir, "c1_default.jpg"), at(5), at(5));
    assert.equal(path.basename((await latestBuildPreview(root, request))!.path), "c1_default.jpg");
    await writeFile(path.join(dir, "s3_after-click.jpg"), "fixture");
    await utimes(path.join(dir, "s3_after-click.jpg"), at(7), at(7));
    assert.equal(path.basename((await latestBuildPreview(root, request))!.path), "s3_after-click.jpg");
    // An empty frame, or one that links outside the runs, is never the picture.
    await writeFile(path.join(dir, "s4_after-type.jpg"), "");
    await utimes(path.join(dir, "s4_after-type.jpg"), at(8), at(8));
    const outside = await mkdtemp(path.join(os.tmpdir(), "preview-outside-"));
    try {
      await writeFile(path.join(outside, "frame.jpg"), "outside");
      await symlink(path.join(outside, "frame.jpg"), path.join(dir, "s5_after-key.jpg"));
      assert.equal(path.basename((await latestBuildPreview(root, request))!.path), "s3_after-click.jpg");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
