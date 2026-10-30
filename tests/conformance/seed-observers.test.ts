/**
 * What the harness captures of a game for a reviewer (`harness-seed/loop/observers.ts`): the
 * plugins' observers through the host and Genex's own web preview through the evidence pass, as one
 * evidence shape. A fake `ctx` (`ctx-recorder`) answers the host's calls; a scripted preview pass
 * stands in for the evidence pass.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PREVIEW_OBSERVER,
} from "../../src/harness-seed/loop/finish-contract.ts";
import {
  observeGame,
  PLUGIN_OBSERVERS,
} from "../../src/harness-seed/loop/observers.ts";
import type { Run } from "../../src/harness-seed/types/harness.d.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { type CtxRecorder, ctxRecorder } from "../helpers/ctx-recorder.ts";

const RUN = { runId: "run_desk", project: "desk-game" } as unknown as Run;
/** A desk game with a web site in `site/`: the plugin's observer, and the preview of the site. */
const GAME = {
  name: "desk-game",
  dir: "/games/desk-game",
  facts: [
    { id: "hk-project", path: "." },
    { id: "web-game", path: "site" },
  ],
};

function recorder(handlers: Parameters<typeof ctxRecorder>[0] = {}): CtxRecorder {
  return ctxRecorder({ threadId: "chat-1", ...handlers });
}

describe("what the harness captures of a game", () => {

  it("a host that cannot capture is a problem, never a throw", async () => {
    const older = recorder();
    const fromOlder = await observeGame(
      older.ctx as never,
      { run: RUN, threadId: "chat-1", game: GAME as never },
      Date.now() + 60_000,
    );
    const [plugins] = fromOlder;
    assert.equal(plugins?.observer, PLUGIN_OBSERVERS);
    assert.ok(plugins?.problem, "an older host that has no capture says so");

    const failing = recorder({
      handlers: {
        [HostMethod.ObserversCapture]: () => {
          throw new Error("the desk fell over");
        },
      },
    });
    const captures = await observeGame(
      failing.ctx as never,
      { run: RUN, threadId: "chat-1", game: GAME as never, previewPass: async () => null },
      Date.now() + 60_000,
    );
    assert.match(String(captures[0]?.problem), /the desk fell over/);
    assert.equal(captures[1]?.observer, PREVIEW_OBSERVER);
    assert.ok(captures[1]?.problem, "a pass that came back empty is a problem too");
  });
});
