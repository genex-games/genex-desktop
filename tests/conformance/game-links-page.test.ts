/**
 * The studio page and `genex://game/<slug>` links: it takes the game a link left waiting as soon
 * as the shell is ready, and each one main announces after, and opens its page in Play. Main
 * hands each game over once, so a link opens one page however often the page asks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { followGameLinks } from "../../src/renderer/shell/use-game-links.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("genex:// links in the studio page", () => {
  it("opens the game a link left waiting, then each one main announces, until it stops", async () => {
    const fake = fakeStudioApi();
    const waiting: Array<string | null> = ["iron-tide", null, "puck-rush"];
    fake.stub("playTakeGameLink", async () => waiting.shift() ?? null);
    const opened: string[] = [];
    const stop = followGameLinks(fake.api, (slug) => opened.push(slug));
    await settle();
    assert.deepEqual(opened, ["iron-tide"], "the link that started Genex");
    fake.emit({ type: UiEvent.PlayGameLink, payload: {} });
    await settle();
    assert.deepEqual(opened, ["iron-tide"], "nothing waits: nothing opens");
    fake.emit({ type: UiEvent.PlayGameLink, payload: {} });
    await settle();
    assert.deepEqual(opened, ["iron-tide", "puck-rush"]);
    stop();
    assert.equal(fake.listeners("onEvent"), 0);
  });

  it("opens nothing when main cannot answer", async () => {
    const fake = fakeStudioApi();
    fake.stub("playTakeGameLink", async () => {
      throw new Error("the window is not open");
    });
    const opened: string[] = [];
    followGameLinks(fake.api, (slug) => opened.push(slug));
    await settle();
    assert.deepEqual(opened, []);
  });
});
