/**
 * A Pro's nameplate roll, kept per account on this Mac: what is stored reads back, junk reads as the
 * first plate, and a roll never repeats the plate shown.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PLATE_VARIANT_MAX } from "../../src/shared/plate-recipe.ts";
import { readPlateVariant, rollPlateVariant } from "../../src/renderer/nameplate/plate-variant.ts";
import { storageKeyFor } from "../../src/renderer/storage.ts";

/** A Map behind the Storage calls the app uses. */
function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const host = globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> };

describe("nameplate roll", () => {
  beforeEach(() => {
    host.localStorage = memoryStorage();
  });
  afterEach(() => {
    delete host.localStorage;
  });

  it("reads the first plate when nothing, or nothing usable, is stored", () => {
    assert.equal(readPlateVariant("a"), 0);
    for (const junk of ["", "-1", "1.5", "nope", String(PLATE_VARIANT_MAX + 1)]) {
      host.localStorage?.setItem(storageKeyFor.plateVariant("a"), junk);
      assert.equal(readPlateVariant("a"), 0, `stored ${JSON.stringify(junk)}`);
    }
  });

  it("keeps a roll per account and never rolls the plate it has", () => {
    const first = rollPlateVariant("a", () => 0.25);
    assert.equal(readPlateVariant("a"), first);
    assert.equal(readPlateVariant("b"), 0);
    assert.notEqual(
      rollPlateVariant("a", () => 0.25),
      first,
    );
  });
});
