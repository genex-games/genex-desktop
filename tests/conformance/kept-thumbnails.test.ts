/**
 * A card's thumbnail across sessions: the picture kept earlier is shown without making one, a
 * picture made now is kept for next time, and the store failing never costs the card its picture.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keptOrMade, pictureOfDataUrl, thumbnailKey } from "../../src/renderer/kept-thumbnails.ts";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

/** A store that records what it was asked, answering `kept` to a read. */
function recorder(kept: { mimeType: string; data: string } | null) {
  const calls: string[] = [];
  return {
    calls,
    read: async () => {
      calls.push("read");
      return kept;
    },
    make: async () => {
      calls.push("make");
      return PNG_URL;
    },
    keep: async (data: string) => {
      calls.push(`keep:${data}`);
      return true;
    },
  };
}

describe("a data URL's picture", () => {
  it("is its base64 bytes, and nothing for a URL that holds none", () => {
    assert.equal(pictureOfDataUrl(PNG_URL), "iVBORw0KGgo=");
    assert.equal(pictureOfDataUrl("data:image/svg+xml,%3Csvg/%3E"), null);
    assert.equal(pictureOfDataUrl("https://example.com/a.png"), null);
    assert.equal(pictureOfDataUrl("data:image/png;base64,"), null);
  });
});

describe("a card's thumbnail", () => {
  it("is the picture kept earlier, with none made", async () => {
    const store = recorder({ mimeType: "image/webp", data: "UklGRg==" });
    assert.equal(await keptOrMade(store), "data:image/webp;base64,UklGRg==");
    assert.deepEqual(store.calls, ["read"]);
  });

  it("is made when none is kept, and kept for next time", async () => {
    const store = recorder(null);
    assert.equal(await keptOrMade(store), PNG_URL);
    assert.deepEqual(store.calls, ["read", "make", "keep:iVBORw0KGgo="]);
  });

  it("is still made when the store cannot be read, and shown when it cannot be written", async () => {
    const store = recorder(null);
    const made = await keptOrMade({
      read: () => Promise.reject(new Error("store unavailable")),
      make: store.make,
      keep: () => Promise.reject(new Error("disk full")),
    });
    assert.equal(made, PNG_URL);
    const thrown = await keptOrMade({
      read: () => {
        throw new Error("no such call");
      },
      make: store.make,
      keep: () => {
        throw new Error("no such call");
      },
    });
    assert.equal(thrown, PNG_URL, "a store call that throws outright");
  });

  it("fails as making it failed, and keeps nothing", async () => {
    const store = recorder(null);
    await assert.rejects(keptOrMade({ ...store, make: () => Promise.reject(new Error("no decoder")) }), /no decoder/);
    assert.deepEqual(store.calls, ["read"]);
  });
});

describe("a thumbnail's key", () => {
  const sprite = { file: "assets/hero.png", mtime: "2026-11-14T10:00:00.000Z", bytes: 900 };
  it("names one version of one file of one game", () => {
    assert.equal(thumbnailKey("keep", sprite), thumbnailKey("keep", { ...sprite }));
    assert.notEqual(thumbnailKey("keep", sprite), thumbnailKey("other", sprite));
    assert.notEqual(
      thumbnailKey("keep", sprite),
      thumbnailKey("keep", { ...sprite, mtime: "2026-11-14T10:00:01.000Z" }),
    );
    assert.notEqual(thumbnailKey("keep", sprite), thumbnailKey("keep", { ...sprite, assetRef: "genex:job/hero.png" }));
  });

  it("never reads back a picture's thumbnail kept before see-through pictures stayed see-through", () => {
    // Earlier thumbnails of pictures were JPEGs, a sprite's transparency painted black.
    const earlier = JSON.stringify(["keep", sprite.file, sprite.mtime, sprite.bytes, undefined]);
    assert.notEqual(thumbnailKey("keep", sprite), earlier);
    // A model's render never lost anything: its kept thumbnail stands.
    const model = { file: "assets/knight.glb", mtime: sprite.mtime, bytes: 900 };
    assert.equal(thumbnailKey("keep", model), JSON.stringify(["keep", model.file, model.mtime, 900, undefined]));
  });
});
