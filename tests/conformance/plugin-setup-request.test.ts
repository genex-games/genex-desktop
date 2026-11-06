/**
 * Opening a plugin's setup on another game (a review notice opens its game with Publish open): the
 * strip of the game on screen leaves it, and the strip that comes up for that game takes it once,
 * only when it has the plugin's panel and only while the request is fresh.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  openPluginSetupFor,
  PENDING_SETUP_MS,
  type PluginSetupRequest,
  settlePendingSetup,
  setupIsFor,
  takePendingSetup,
} from "../../src/renderer/plugin-setup.ts";

const dispatched: PluginSetupRequest[] = [];
const holder = globalThis as { window?: unknown };

beforeEach(() => {
  dispatched.length = 0;
  holder.window = {
    dispatchEvent: (event: CustomEvent<PluginSetupRequest>) => dispatched.push(event.detail),
  };
});
afterEach(() => {
  // Whatever a test left waiting goes, so the next starts clean.
  takePendingSetup("asphalt", () => true, Number.POSITIVE_INFINITY);
  delete holder.window;
});

describe("a plugin's setup on another game", () => {
  it("is told at once, and only that game's strip answers it", () => {
    openPluginSetupFor("asphalt", "genex", undefined, 0);
    assert.deepEqual(
      dispatched.map((request) => [request.id, request.project]),
      [["genex", "asphalt"]],
    );
    assert.equal(setupIsFor(dispatched[0]!, "skate"), false);
    assert.equal(setupIsFor(dispatched[0]!, "asphalt"), true);
    assert.equal(setupIsFor({}, "skate"), true, "a request with no game is the game on screen's");
  });

  it("waits for that game's strip, taken once when it has the panel", () => {
    openPluginSetupFor("asphalt", "genex", undefined, 0);
    assert.equal(
      takePendingSetup("skate", () => true, 1),
      null,
      "another game's strip leaves it",
    );
    assert.equal(
      takePendingSetup("asphalt", () => false, 1),
      null,
      "a strip without the panel yet leaves it",
    );
    assert.equal(takePendingSetup("asphalt", () => true, 2)?.id, "genex");
    assert.equal(
      takePendingSetup("asphalt", () => true, 3),
      null,
      "taken once",
    );
  });

  it("is dropped when no strip took it in time, or once a strip opened it", () => {
    openPluginSetupFor("asphalt", "genex", undefined, 0);
    assert.equal(
      takePendingSetup("asphalt", () => true, PENDING_SETUP_MS + 1),
      null,
    );
    openPluginSetupFor("asphalt", "genex", undefined, 0);
    settlePendingSetup({ id: "genex", from: "setup_request", project: "asphalt" });
    assert.equal(
      takePendingSetup("asphalt", () => true, 1),
      null,
    );
  });
});
