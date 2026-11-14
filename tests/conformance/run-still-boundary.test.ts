import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { PreviewService } from "../../src/main/core/previews.ts";
import { unservedPreviews, type CoreInternals } from "../../src/main/core/internals.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { tmpDir } from "../helpers/tmp.ts";

test("run still thumbnails refuse oversized and escaping files before resizing", async () => {
  const root = await tmpDir("run-still-");
  const runs = path.join(root, "runs");
  await mkdir(runs);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.alloc(32)]);
  const inside = path.join(runs, "picture.jpg");
  const outside = path.join(root, "outside.jpg");
  await writeFile(inside, jpeg);
  await writeFile(outside, jpeg);
  const oversized = path.join(runs, "large.jpg");
  await writeFile(oversized, Buffer.concat([jpeg, Buffer.alloc(17 * 1024 * 1024)]));
  const resized: number[] = [];
  const core = {
    layout: { runs },
    options: {
      previewPoolMax: 0,
      preview: {
        resizeImage: async (_data: Buffer, size: number) => {
          resized.push(size);
          return jpeg;
        },
      },
    },
  } as unknown as StudioCore;
  const service = new PreviewService(core, unservedPreviews() as CoreInternals);
  for (const file of [outside, path.join(runs, "..", "outside.jpg"), oversized, runs]) {
    assert.equal(await service.readRunStill(file, 640), null);
  }
  if (process.platform !== "win32") {
    const link = path.join(runs, "escape.jpg");
    await symlink(outside, link);
    assert.equal(await service.readRunStill(link, 640), null);
  }
  for (const size of [0, -1, NaN, Infinity, 0.5, 100000]) assert.equal(await service.readRunStill(inside, size), null);
  assert.deepEqual(resized, []);
  assert.equal((await service.readRunStill(inside, 640))?.mimeType, "image/jpeg");
  assert.deepEqual(resized, [640]);
});

test("a run still made smaller says the type its new bytes are", async () => {
  const root = await tmpDir("run-still-type-");
  const runs = path.join(root, "runs");
  await mkdir(runs);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const sprite = path.join(runs, "sprite.png");
  await writeFile(sprite, png);
  const core = {
    layout: { runs },
    // The preview keeps a see-through picture a PNG when it makes it smaller.
    options: { previewPoolMax: 0, preview: { resizeImage: async () => png } },
  } as unknown as StudioCore;
  const service = new PreviewService(core, unservedPreviews() as CoreInternals);
  assert.equal((await service.readRunStill(sprite, 640))?.mimeType, "image/png");
});
