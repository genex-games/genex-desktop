/**
 * The stage strip stays one row: its labelled buttons fold into icons together once the row would
 * overflow, and unfold only when the labelled row fits again (`nextFold`, which `useStripFold`
 * feeds with the strip's own widths).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextFold, UNFOLDED } from "../../src/renderer/panels/stage/strip-fold.ts";

test("a row that fits keeps its labels", () => {
  assert.deepEqual(nextFold(UNFOLDED, { scroll: 600, client: 600 }), UNFOLDED);
  assert.deepEqual(nextFold(UNFOLDED, { scroll: 320, client: 900 }), UNFOLDED);
});

test("a row that would overflow folds, remembering how wide its labels need it to be", () => {
  assert.deepEqual(nextFold(UNFOLDED, { scroll: 721, client: 600 }), { folded: true, needed: 721 });
});

test("a folded row unfolds only once the strip is as wide as the labelled row needed", () => {
  const folded = nextFold(UNFOLDED, { scroll: 720, client: 600 });
  assert.deepEqual(nextFold(folded, { scroll: 480, client: 719 }), folded, "one pixel short stays folded");
  assert.deepEqual(nextFold(folded, { scroll: 480, client: 720 }), UNFOLDED);
});

test("a folded row that still overflows stays folded and keeps what its labels needed", () => {
  const folded = nextFold(UNFOLDED, { scroll: 720, client: 600 });
  assert.deepEqual(nextFold(folded, { scroll: 520, client: 400 }), folded);
});
