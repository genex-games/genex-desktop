/**
 * What a run says when `game.upgradeContract` kept an edited `src/studio.js`: the lead and the
 * person are told the game holds its own older contract, so nobody builds on HUD calls its facade
 * does not have, and nobody reads the quiet start as an upgrade.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keptContractWords } from "../../src/harness-seed/loop/contract-kept.ts";

describe("a kept contract", () => {
  it("says nothing for an upgrade, a current contract or an older host's answer", () => {
    assert.equal(keptContractWords(null), null);
    assert.equal(keptContractWords({ upgraded: true, backup: "src/studio.v4.js" }), null);
    assert.equal(keptContractWords({ upgraded: false, materialsAdded: false }), null);
    // A host from before `edited` existed answers neither field.
    assert.equal(keptContractWords({ upgraded: false }), null);
  });

  it("names the generation an edited copy stays at, for the record and in plain words", () => {
    const words = keptContractWords({ upgraded: false, edited: true, generation: 4, materialsAdded: false });
    assert.ok(words, "an edited copy is reported");
    assert.match(words.record, /src\/studio\.js/);
    assert.match(words.record, /generation 4/);
    assert.ok(words.plain.length > 0);
    assert.doesNotMatch(`${words.record} ${words.plain}`, /\b(night|morning|overnight|tonight)\b/i);
  });

  it("names the HUD calls an older facade lacks", () => {
    const m4 = keptContractWords({ upgraded: false, edited: true, generation: 4 });
    assert.ok(m4);
    for (const call of ["arc", "panel", "path", "image", "font"]) assert.match(m4.record, new RegExp(`\\b${call}\\b`));
  });
});
