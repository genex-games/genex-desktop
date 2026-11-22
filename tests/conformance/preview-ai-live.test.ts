/**
 * The practice helper through the real core and the pinned CLI (`genex llm practice --json`, made-up
 * answers: no account, no network): Live's page of a game that calls play-time models is loaded with
 * the helper's key, the helper answers on it, and Stop, a switch to another game and the app's quit
 * each leave no helper running. A game that calls no model gets no helper.
 */
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { withGenexSdkImport } from "../../src/shared/genex-page.ts";
import { PreviewAiMode } from "../../src/shared/preview-ai.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TEMPLATE_PAGE = path.join(ROOT, "src/game-template/index.html");
const NPC =
  'import { requestSpendGrant, generateStream } from "@genex-ai/embed-sdk";\nexport const ask = () => requestSpendGrant({});';

/** A Live view that records what it loads. */
function livePort() {
  const port = {
    loads: [] as string[],
    stopped: 0,
    async load(project: string, entry: string, _root?: string, options: { loopback?: boolean } = {}) {
      port.loads.push(entry);
      return options.loopback ? `http://localhost:41000/${entry}` : `game://${project}/${entry}`;
    },
    async reload() {},
    async stop() {
      port.stopped += 1;
    },
    async resume() {},
    status: () => ({ project: "inn", loadError: null, consoleErrors: [], url: null }),
    async evaluate() {
      return { via: "contract", ready: true, phase: "ready" };
    },
  };
  return port;
}

/** The repository's pinned CLI, which the app's build copies into resources. */
const PINNED_CLI = path.join(ROOT, "node_modules/@genex-ai/cli-demo/dist/index.js");

/** A core with Live, and two template games: one that calls a model, one that does not. */
async function studio() {
  const port = livePort();
  const gamesRoot = await realpath(await tmpDir("studio-practice-"));
  const lite = await coreLite({ preview: port as never, gamesRoot, genexCli: PINNED_CLI });
  const page = withGenexSdkImport(await readFile(TEMPLATE_PAGE, "utf8")) ?? "";
  for (const [name, code] of [
    ["inn", NPC],
    ["quiet", "export const x = 1;"],
  ]) {
    const game = await lite.core.games.scaffold(name);
    await writeFile(path.join(game.dir, "index.html"), page);
    await writeFile(path.join(game.dir, "src", "npc.js"), code);
  }
  return { lite, port };
}

/** The practice key in a loaded entry, or null. */
const keyIn = (entry: string | undefined) => new URLSearchParams(entry?.split("?")[1] ?? "").get("genex_llm_practice");

describe("Live answers model calls with practice answers", () => {
  it("loads the game with the helper's key, the helper answers it, and Stop ends it", async () => {
    const { lite, port } = await studio();
    try {
      await lite.core.loadPreview({ project: "inn" });
      const key = keyIn(port.loads.at(-1));
      assert.match(key ?? "", /^\d+\.[0-9a-f]{32}$/);
      const [helperPort, token] = (key ?? "").split(".");
      const models = await fetch(`http://127.0.0.1:${helperPort}/api/runtime/models`, {
        headers: { Authorization: `Bearer ${token}`, Origin: "http://localhost:41000" },
      });
      assert.equal(models.status, 200, "the helper answers the page's origin with its token");
      assert.equal(lite.core.previewAi.state("inn").mode, PreviewAiMode.Practice);
      const pids = lite.core.previewAi.runningPids();
      assert.equal(pids.length, 1);
      await lite.core.stopLive();
      assert.deepEqual(lite.core.previewAi.runningPids(), []);
      for (const pid of pids) assert.equal(running(pid), false, "no helper is left after Stop");
      await lite.core.playLive();
      const again = keyIn(port.loads.at(-1));
      assert.ok(again && again !== key, "Play serves the page again with a new helper's key");
    } finally {
      await lite.close();
    }
  });

  it("gives a game that calls no model no helper, and stops the last game's when Live moves", async () => {
    const { lite, port } = await studio();
    try {
      await lite.core.loadPreview({ project: "inn" });
      const pids = lite.core.previewAi.runningPids();
      await lite.core.loadPreview({ project: "quiet" });
      assert.equal(keyIn(port.loads.at(-1)), null);
      assert.deepEqual(lite.core.previewAi.runningPids(), []);
      for (const pid of pids) assert.equal(running(pid), false);
    } finally {
      await lite.close();
    }
  });

  it("stops the helper when the app quits", async () => {
    const { lite } = await studio();
    await lite.core.loadPreview({ project: "inn" });
    const pids = lite.core.previewAi.runningPids();
    assert.equal(pids.length, 1);
    await lite.close();
    for (const pid of pids) assert.equal(running(pid), false);
  });

  it("refuses real models in a profile that never spends", async () => {
    const { lite } = await studio();
    try {
      await lite.core.loadPreview({ project: "inn" });
      const state = await lite.core.previewAi.startRealModels("inn", 100);
      assert.equal(state.mode, PreviewAiMode.Unavailable);
      assert.equal(state.reason, "not_here");
    } finally {
      await lite.close();
    }
  });
});
