/**
 * The page the build health check loads carries one query parameter, `genex-shot`: the load whose
 * screenshot becomes the build's picture. A game may read it to show a still view; one that ignores
 * it loses nothing. Every other load serves the page as it is.
 */
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { describe, it } from "node:test";
import { SHOT_QUERY } from "../../src/shared/preview-contract.ts";
import { harnessParamsProblem, HostMethod } from "../../src/shared/harness-api.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A preview port that records the page each load opened. */
function recordingPort() {
  const entries: string[] = [];
  return {
    entries,
    port: {
      async load(project: string, entry: string) {
        entries.push(entry);
        return `game://${project}/${entry}`;
      },
      async reload() {},
      async input() {},
      status: () => ({ project: null, loadError: null, consoleErrors: [], url: null }),
      async evaluate() {
        return { via: "contract", ready: true, phase: "ready" };
      },
      async dispose() {},
    },
  };
}

describe("the health check's page", () => {
  it("is the game's own page with the shot parameter; any other load has none", async () => {
    const { entries, port } = recordingPort();
    const lite = await coreLite({
      preview: port as never,
      gamesRoot: await realpath(await tmpDir("studio-health-shot-")),
    });
    try {
      await lite.core.games.scaffold("pong");
      const url = await lite.core.loadPreview({ project: "pong", shot: true });
      await lite.core.loadPreview({ project: "pong" });
      await lite.core.loadPreview({ project: "pong", entry: "levels/two.html", shot: true });
      assert.deepEqual(entries, [`index.html?${SHOT_QUERY}=1`, "index.html", `levels/two.html?${SHOT_QUERY}=1`]);
      assert.equal(url, `game://pong/index.html?${SHOT_QUERY}=1`);
    } finally {
      await lite.close();
    }
  });

  it("reaches the host from the harness as a flag, never as words to put in the address", async () => {
    assert.equal(harnessParamsProblem(HostMethod.PreviewLoad, { project: "pong", shot: true }), null);
    for (const hostile of ["1&steal=1", "#x", 1, {}])
      assert.notEqual(
        harnessParamsProblem(HostMethod.PreviewLoad, { project: "pong", shot: hostile }),
        null,
        String(hostile),
      );
  });
});
