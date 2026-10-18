import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  confinedCaptureDir,
  latestBuildPreview,
  writeCaptureManifest,
  writeCaptureRefusal,
} from "../../src/substrate/build-preview.ts";
import {
  CAPTURE_MANIFEST_VERSION,
  type CaptureManifest,
  CaptureRefusal,
  captureProvenanceOf,
} from "../../src/shared/build-preview.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
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

test("a saved capture's provenance sidecar reaches the frame; a hostile one is left out, never followed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-preview-provenance-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "preview-provenance-outside-"));
  try {
    const dir = path.join(root, "run_x/facet_river/self/iter_001");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "c3_default.jpg"), "fixture");
    const request = { runId: "run_x", facetId: "river", iteration: 1 };
    const provenance = {
      seq: 3,
      digest: "a".repeat(16),
      camera: "default",
      runId: "run_x",
      build: { stack: "rust-wgpu", target: "macos", digest: "b".repeat(64), lock: "c".repeat(64) },
    };
    const sidecar = path.join(dir, "c3_default.provenance.json");
    await writeFile(sidecar, JSON.stringify(provenance));
    // A sidecar saved before captures kept their render settings and size reads them as null.
    assert.deepEqual((await latestBuildPreview(root, request))?.provenance, {
      ...provenance,
      render: null,
      outputSize: null,
    });

    const hostile: Array<[string, () => Promise<void>]> = [
      ["not JSON", () => writeFile(sidecar, "{")],
      ["a wrong shape", () => writeFile(sidecar, JSON.stringify({ ...provenance, seq: "3" }))],
      [
        "an unknown stack",
        () => writeFile(sidecar, JSON.stringify({ ...provenance, build: { ...provenance.build, stack: "x" } })),
      ],
      ["too large", () => writeFile(sidecar, JSON.stringify({ ...provenance, camera: "x".repeat(70_000) }))],
      [
        "a link out of the runs folder",
        async () => {
          await writeFile(path.join(outside, "p.json"), JSON.stringify(provenance));
          await symlink(path.join(outside, "p.json"), sidecar);
        },
      ],
    ];
    for (const [why, plant] of hostile) {
      await rm(sidecar, { force: true });
      await plant();
      const frame = await latestBuildPreview(root, request);
      assert.equal(path.basename(frame?.path ?? ""), "c3_default.jpg", why);
      assert.equal(frame?.provenance, undefined, why);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a capture's manifest round-trips beside its frame; a folder without one still loads; a hostile one is left out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-preview-manifest-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "preview-manifest-outside-"));
  try {
    const dir = path.join(root, "run_x/facet_river/self/iter_001");
    await mkdir(dir, { recursive: true });
    const request = { runId: "run_x", facetId: "river", iteration: 1 };
    // A folder saved before manifests were written still loads, with neither field.
    await writeFile(path.join(dir, "c1_default.jpg"), "fixture");
    const old = await latestBuildPreview(root, request);
    assert.equal(path.basename(old?.path ?? ""), "c1_default.jpg");
    assert.equal(old?.manifest, undefined);
    assert.equal(old?.provenance, undefined);

    const frame = path.join(dir, "c2_default.jpg");
    await writeFile(frame, "fixture");
    const manifest: CaptureManifest = {
      version: CAPTURE_MANIFEST_VERSION,
      runId: "run_x",
      workerId: "river",
      call: 2,
      camera: "default",
      commit: "e".repeat(40),
      edited: true,
      capturedAt: new Date(0).toISOString(),
      provenance: {
        seq: 9,
        digest: "a".repeat(16),
        camera: "default",
        runId: "native-run-1",
        build: { stack: GameStack.RustWgpu, target: BuildTarget.Mac, digest: "b".repeat(64), lock: "c".repeat(64) },
        render: null,
        outputSize: null,
      },
    };
    const written = await writeCaptureManifest(frame, manifest);
    assert.equal(path.basename(written), "c2_default.manifest.json", "the manifest is saved beside its frame");
    const read = await latestBuildPreview(root, request);
    assert.equal(path.basename(read?.path ?? ""), "c2_default.jpg");
    assert.deepEqual(read?.manifest, manifest);
    assert.deepEqual(read?.provenance, manifest.provenance, "the frame's provenance is the manifest's");

    // Fields a manifest does not have are dropped, never handed on.
    await writeFile(written, JSON.stringify({ ...manifest, extra: "x", provenance: { ...manifest.provenance, y: 1 } }));
    assert.deepEqual((await latestBuildPreview(root, request))?.manifest, manifest);

    const hostile: Array<[string, () => Promise<void>]> = [
      ["not JSON", () => writeFile(written, "{")],
      ["another version", () => writeFile(written, JSON.stringify({ ...manifest, version: 2 }))],
      ["a negative call", () => writeFile(written, JSON.stringify({ ...manifest, call: -1 }))],
      ["a worker that is not text", () => writeFile(written, JSON.stringify({ ...manifest, workerId: { id: 1 } }))],
      ["an undated capture", () => writeFile(written, JSON.stringify({ ...manifest, capturedAt: "soon" }))],
      [
        "a provenance of the wrong shape",
        () => writeFile(written, JSON.stringify({ ...manifest, provenance: { ...manifest.provenance, seq: "9" } })),
      ],
      ["too large", () => writeFile(written, JSON.stringify({ ...manifest, commit: "x".repeat(70_000) }))],
      [
        "a link out of the runs folder",
        async () => {
          await writeFile(path.join(outside, "m.json"), JSON.stringify(manifest));
          await symlink(path.join(outside, "m.json"), written);
        },
      ],
    ];
    for (const [why, plant] of hostile) {
      await rm(written, { force: true });
      await plant();
      const hostileFrame = await latestBuildPreview(root, request);
      assert.equal(path.basename(hostileFrame?.path ?? ""), "c2_default.jpg", why);
      assert.equal(hostileFrame?.manifest, undefined, why);
      assert.equal(hostileFrame?.provenance, undefined, why);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

/** A manifest as a builder capture saves it, for the rows below. */
const savedManifest = (fields: Partial<CaptureManifest> = {}): CaptureManifest => ({
  version: CAPTURE_MANIFEST_VERSION,
  runId: "run_x",
  workerId: "river",
  call: 1,
  camera: "default",
  commit: null,
  edited: null,
  capturedAt: "2026-10-08T00:00:00.000Z",
  provenance: { seq: null, digest: null, camera: "default", runId: null, build: null, render: null, outputSize: null },
  ...fields,
});

test("a sidecar saved before captures kept their settings and size reads them as unknown; a bad one is refused", () => {
  const older = { seq: 3, digest: "a".repeat(16), camera: "default", runId: null, build: null };
  assert.deepEqual(captureProvenanceOf(older), { ...older, render: null, outputSize: null });
  for (const outputSize of [{ width: 0, height: 2 }, { width: 2.5, height: 2 }, { width: 2 }, "1280x720"]) {
    assert.equal(captureProvenanceOf({ ...older, outputSize }), null, JSON.stringify(outputSize));
  }
  assert.equal(captureProvenanceOf({ ...older, render: { preset: "low" } }), null, "a render record out of its shape");
});

test("a frame or manifest linked in from another worker's folder is not this one's", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-preview-cross-"));
  try {
    const dir = path.join(root, "run_x/facet_river/self/iter_001");
    const other = path.join(root, "run_x/facet_lake/self/iter_001");
    await mkdir(dir, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(path.join(dir, "c2_default.jpg"), "river's own");
    await writeFile(path.join(other, "c5_default.jpg"), "lake's");
    await writeCaptureManifest(path.join(other, "c5_default.jpg"), savedManifest({ workerId: "lake", call: 5 }));
    // Linked in under river's newer names, with no manifest of river's own beside the frame.
    await symlink(path.join(other, "c5_default.jpg"), path.join(dir, "c5_default.jpg"));
    await symlink(path.join(other, "c5_default.manifest.json"), path.join(dir, "c2_default.manifest.json"));
    const frame = await latestBuildPreview(root, { runId: "run_x", facetId: "river", iteration: 1 });
    assert.equal(path.basename(frame?.path ?? ""), "c2_default.jpg", "another worker's frame is never river's newest");
    assert.equal(frame?.manifest, undefined, "nor is its manifest read as river's");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a newer capture whose build failed leaves no older frame standing in for it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-preview-refused-"));
  try {
    const dir = path.join(root, "run_x/facet_river/self/iter_001");
    await mkdir(dir, { recursive: true });
    const request = { runId: "run_x", facetId: "river", iteration: 1 };
    await writeFile(path.join(dir, "c1_default.jpg"), "the older build");
    await writeCaptureRefusal(dir, savedManifest({ call: 2, refused: CaptureRefusal.BuildFailed }));
    assert.equal(await latestBuildPreview(root, request), null, "the newest capture is the failure");

    await writeFile(path.join(dir, "c3_default.jpg"), "a build that works again");
    assert.equal(path.basename((await latestBuildPreview(root, request))?.path ?? ""), "c3_default.jpg");

    await rm(path.join(dir, "c3_default.jpg"));
    await writeFile(path.join(dir, "c2.refused.json"), "{");
    assert.equal(
      path.basename((await latestBuildPreview(root, request))?.path ?? ""),
      "c1_default.jpg",
      "a record that does not check out hides nothing",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a capture folder is made only inside the runs folder, never through a link or a file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-preview-confined-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "build-preview-confined-outside-"));
  try {
    const made = await confinedCaptureDir(root, path.join(root, "run_x/facet_river/self/iter_001"));
    assert.ok(made.endsWith(path.join("run_x", "facet_river", "self", "iter_001")));
    const hostile: Array<[string, string, () => Promise<void>]> = [
      ["outside the runs folder", path.join(outside, "iter_001"), async () => {}],
      ["the runs folder itself", root, async () => {}],
      ["a climb out of it", path.join(root, "..", "iter_001"), async () => {}],
      [
        "a link to a folder outside",
        path.join(root, "run_y/facet_river/self/iter_001"),
        () => symlink(outside, path.join(root, "run_y")),
      ],
      [
        "a file in the way",
        path.join(root, "run_z/facet_river/self/iter_001"),
        () => writeFile(path.join(root, "run_z"), "not a folder"),
      ],
    ];
    for (const [why, dir, plant] of hostile) {
      await plant();
      await assert.rejects(confinedCaptureDir(root, dir), why);
    }
    assert.deepEqual(await readdir(outside), [], "nothing was made outside");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
