import { test } from "node:test";
import assert from "node:assert/strict";
import { engineSlot, setEngineSlot, subscribeEngineSlot } from "../../src/renderer/panels/engine-slot.ts";

test("the chat header offers the engine button's place and takes it back; the toolbar hears each change once", () => {
  const header = {} as HTMLElement;
  const other = {} as HTMLElement;
  let heard = 0;
  const stop = subscribeEngineSlot(() => heard++);
  assert.equal(engineSlot(), null, "no header yet: the button stays on the strip");
  setEngineSlot(header);
  setEngineSlot(header);
  assert.equal(engineSlot(), header);
  assert.equal(heard, 1, "offering the same place again is no change");
  // A header remounted for another chat hands its place over: the old one goes, the new one comes.
  setEngineSlot(null);
  setEngineSlot(other);
  assert.equal(engineSlot(), other);
  assert.equal(heard, 3);
  stop();
  setEngineSlot(null);
  assert.equal(engineSlot(), null);
  assert.equal(heard, 3, "an unsubscribed toolbar hears nothing");
});
