import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStill, stillNow } from "../../src/renderer/stills.ts";
import { fakeStudioApi, installFakeStudio } from "../helpers/fake-studio-api.ts";

test("still cache bounds retained images and refreshes the least recently used entry", async () => {
  const reads: string[] = [];
  const studio = fakeStudioApi({
    readRunStill: async (file) => {
      reads.push(file);
      return { mimeType: "image/jpeg", data: file };
    },
  });
  const restore = installFakeStudio(studio);
  try {
    for (let i = 0; i < 300; i++) await loadStill({ run: `bounded-${i}` });
    await loadStill({ run: "bounded-0" });
    assert.equal(reads.filter((file) => file === "bounded-0").length, 2);
    await loadStill({ run: "bounded-299" });
    assert.equal(reads.filter((file) => file === "bounded-299").length, 1);
  } finally {
    restore();
  }
});

test("a newer version evicts the previous still for the same path", async () => {
  let reads = 0;
  const studio = fakeStudioApi({
    readRunStill: async () => {
      reads++;
      return { mimeType: "image/jpeg", data: "image" };
    },
  });
  const restore = installFakeStudio(studio);
  try {
    await loadStill({ run: "versioned", version: "1" });
    await loadStill({ run: "versioned", version: "2" });
    await loadStill({ run: "versioned", version: "1" });
    assert.equal(reads, 3);
  } finally {
    restore();
  }
});

test("a still already read is there at once for a card that mounts again; a retry capture never is", async () => {
  const studio = fakeStudioApi({ readRunStill: async (file) => ({ mimeType: "image/jpeg", data: file }) });
  const restore = installFakeStudio(studio);
  try {
    assert.equal(stillNow({ run: "shot-now" }), undefined, "nothing before the first read");
    const read = await loadStill({ run: "shot-now" });
    assert.equal(stillNow({ run: "shot-now" }), read);
    await loadStill({ run: "capture", retry: "1" });
    assert.equal(stillNow({ run: "capture", retry: "1" }), undefined);
  } finally {
    restore();
  }
});
