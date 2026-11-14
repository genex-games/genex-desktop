/**
 * How a card's picture fills its frame: a picture with nothing see-through fills it edge to edge,
 * so no band of the frame shows above or below it; a model's render and a see-through sprite keep
 * their whole shape on what is behind the frame.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThumbnailFit, thumbnailFit } from "../../src/renderer/thumbnail-fit.ts";

const JPEG = "data:image/jpeg;base64,/9j/4AAQ";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("a thumbnail's fit", () => {
  it("fills the frame with an opaque picture and a clip's frame", () => {
    assert.equal(thumbnailFit({ file: "assets/shot.png" }, JPEG), ThumbnailFit.Cover, "a game screenshot");
    assert.equal(thumbnailFit({ file: "assets/photo.jpg" }, JPEG), ThumbnailFit.Cover);
    assert.equal(thumbnailFit({ file: "assets/intro.mp4" }, PNG), ThumbnailFit.Cover, "a video's first frame");
  });

  it("keeps the whole of a see-through sprite and of a model's render", () => {
    assert.equal(thumbnailFit({ file: "assets/hero.png" }, PNG), ThumbnailFit.Contain, "a sprite kept as PNG");
    assert.equal(thumbnailFit({ file: "assets/hero.webp" }, "data:image/webp;base64,UklG"), ThumbnailFit.Contain);
    assert.equal(thumbnailFit({ file: "assets/knight.glb" }, PNG), ThumbnailFit.Contain);
    assert.equal(thumbnailFit({ file: "assets/rock.ktx2" }, PNG), ThumbnailFit.Contain);
    assert.equal(thumbnailFit({ file: "assets/knight.glb", render: "/runs/r/knight.png" }, JPEG), ThumbnailFit.Contain);
  });

  it("keeps the whole picture when it cannot tell what the picture is", () => {
    for (const src of ["", "blob:abc", "https://example.com/a.jpg", "data:,", "data:image/jpeg"]) {
      assert.equal(thumbnailFit({ file: "assets/a.png" }, src), ThumbnailFit.Contain, src);
    }
  });
});
