import assert from "node:assert/strict";
import test from "node:test";
import { previewVisibility } from "../../src/main/preview-visibility.ts";

test("modal occlusion dominates stage and observer visibility in either arrival order", () => {
  for (const initialVisible of [false, true]) {
    const applied: boolean[] = [];
    const visibility = previewVisibility((visible) => applied.push(visible));
    visibility.setVisible(initialVisible);
    visibility.setOccluded(true);
    visibility.setVisible(true);
    assert.equal(applied.at(-1), false);
    visibility.setVisible(false);
    visibility.setOccluded(false);
    assert.equal(applied.at(-1), false);
    visibility.setVisible(true);
    assert.equal(applied.at(-1), true);
    visibility.setOccluded(true);
    assert.equal(applied.at(-1), false);
    visibility.setOccluded(false);
    assert.equal(applied.at(-1), true);
  }
});

// The view keeps its size where it was last shown while its slot is off the stage (`placedBounds`),
// so being hidden is the only thing keeping it from painting over the loader or a dialog.
test("a view whose slot is off the stage is never shown, whoever asks for it", () => {
  const applied: boolean[] = [];
  const visibility = previewVisibility((visible) => applied.push(visible));
  visibility.setPlaced(false);
  assert.equal(applied.at(-1), false);
  visibility.setVisible(true);
  assert.equal(applied.at(-1), false, "the stage or an agent looking does not show it");
  visibility.setPlaced(true);
  assert.equal(applied.at(-1), true);
  visibility.setOccluded(true);
  visibility.setPlaced(false);
  visibility.setPlaced(true);
  assert.equal(applied.at(-1), false, "a modal still occludes it once it is back on the stage");
  visibility.setOccluded(false);
  assert.equal(applied.at(-1), true);
});
