/**
 * When a game page's Store section is read again (marketplace plan 10.2): its Store tab when the page
 * opens, My items the first time it is chosen, both after the account changes and after a purchase
 * or a claim, and the half on show again when it is chosen again or the window comes back to the
 * front, a burst of those once (`REREAD_GAP_MS`), so an item added or removed elsewhere shows up
 * without leaving the page and nothing storms genex.games.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gameStoreReads } from "../../src/renderer/play/game-store-reads.ts";
import { StoreView } from "../../src/renderer/play/store-model.ts";
import { REREAD_GAP_MS } from "../../src/renderer/state/refresher.ts";

function reader() {
  let now = 0;
  const reads: string[] = [];
  const store = gameStoreReads({ readTab: () => reads.push("store"), readMine: () => reads.push("mine") }, () => now);
  return {
    store,
    reads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("a game page's Store section, read again", () => {
  it("reads the Store tab on opening, and My items the first time it is chosen", () => {
    const { store, reads } = reader();
    store.all();
    store.chose(StoreView.MyItems);
    assert.deepEqual(reads, ["store", "mine"]);
  });

  it("reads the half chosen again once its last read is old, and not for a quick back and forth", () => {
    const { store, reads, advance } = reader();
    store.all();
    store.chose(StoreView.MyItems);
    store.chose(StoreView.Store);
    store.chose(StoreView.MyItems);
    assert.deepEqual(reads, ["store", "mine"]);
    advance(REREAD_GAP_MS);
    store.chose(StoreView.Store);
    store.chose(StoreView.MyItems);
    assert.deepEqual(reads, ["store", "mine", "store", "mine"]);
  });

  it("reads the half on show once for a burst of window focus, and the tab with it for My items' count", () => {
    const { store, reads, advance } = reader();
    store.all();
    advance(REREAD_GAP_MS);
    store.focused(StoreView.Store);
    store.focused(StoreView.Store);
    assert.deepEqual(reads, ["store", "store"]);
    store.chose(StoreView.MyItems);
    advance(REREAD_GAP_MS);
    store.focused(StoreView.MyItems);
    store.focused(StoreView.MyItems);
    assert.deepEqual(reads, ["store", "store", "mine", "store", "mine"]);
  });

  it("reads everything again after a purchase or a sign-in, however recently it was read", () => {
    const { store, reads } = reader();
    store.all();
    store.all();
    assert.deepEqual(reads, ["store", "store"], "My items not chosen yet: only the Store tab");
    store.chose(StoreView.MyItems);
    store.all();
    assert.deepEqual(reads, ["store", "store", "mine", "store", "mine"]);
  });
});
