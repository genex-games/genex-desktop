/**
 * The practice helper for a game played in the Unreal editor, through the real core and the pinned
 * CLI (`genex llm practice --json`, made-up answers: no account, no network). While Live shows the
 * game's Unreal card, the game's `.studio/llm-practice.json` names a helper that answers; Live
 * leaving the game, Live's Stop and the app's quit each remove the file and leave no helper
 * running. A web game's Live is as it was, but for a page whose helper went to the Unreal game.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { withGenexSdkImport } from "../../src/shared/genex-page.ts";
import { PreviewAiMode } from "../../src/shared/preview-ai.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TEMPLATE_PAGE = path.join(ROOT, "src/game-template/index.html");
/** The repository's pinned CLI, which the app's build copies into resources. */
const PINNED_CLI = path.join(ROOT, "node_modules/@genex-ai/cli-demo/dist/index.js");
const HANDOFF = path.join(".studio", "llm-practice.json");
const WEB_NPC =
  'import { requestSpendGrant } from "@genex-ai/embed-sdk";\nexport const ask = () => requestSpendGrant({});';
const UNREAL_NPC = "void UNpc::Ask() { GetGameInstance()->GetSubsystem<UGenexModelsSubsystem>()->Generate({}); }";

/** A Live view that records what it loads and how often it was stopped. */
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
    status: () => ({ project: "web", loadError: null, consoleErrors: [], url: null }),
    async evaluate() {
      return { via: "contract", ready: true, phase: "ready" };
    },
  };
  return port;
}

/**
 * A core with Live and four games: two Unreal games with Genex's kit, `inn` whose code calls the
 * models and `mill` whose code does not, and two web games, `web` that calls a model and `plain`
 * that calls none.
 */
async function studio() {
  const port = livePort();
  const gamesRoot = await realpath(await tmpDir("studio-editor-practice-"));
  const lite = await coreLite({ preview: port as never, gamesRoot, genexCli: PINNED_CLI });
  const dirs: Record<string, string> = {};
  for (const [name, code] of [
    ["inn", UNREAL_NPC],
    ["mill", "void UNpc::Ask() {}"],
  ]) {
    const game = await lite.core.games.scaffold(name);
    const unreal = path.join(game.dir, "unreal");
    await mkdir(path.join(unreal, "Plugins", "GenexMultiplayer"), { recursive: true });
    await mkdir(path.join(unreal, "Source", "Game"), { recursive: true });
    await writeFile(path.join(unreal, "Source", "Game", "Npc.cpp"), code);
    dirs[name] = game.dir;
  }
  const page = withGenexSdkImport(await readFile(TEMPLATE_PAGE, "utf8")) ?? "";
  for (const [name, code] of [
    ["web", WEB_NPC],
    ["plain", "export const x = 1;"],
  ]) {
    const game = await lite.core.games.scaffold(name);
    await writeFile(path.join(game.dir, "index.html"), page);
    await writeFile(path.join(game.dir, "src", "npc.js"), code);
    dirs[name] = game.dir;
  }
  const handoff = (name: string) => readFile(path.join(dirs[name] ?? "", HANDOFF), "utf8").catch(() => null);
  return { lite, port, dirs, handoff };
}

/** The key a handoff names, or null. */
function keyIn(text: string | null): string | null {
  const key: unknown = text === null ? null : JSON.parse(text).key;
  return typeof key === "string" ? key : null;
}

/** The practice key in a loaded entry, or null. */
const pageKey = (entry: string | undefined) =>
  new URLSearchParams(entry?.split("?")[1] ?? "").get("genex_llm_practice");

describe("an Unreal game's play in the editor answers model calls from Live's helper", () => {
  it("names a helper that answers while Live shows the card, and removes it when Live leaves", async () => {
    const { lite, handoff } = await studio();
    try {
      await lite.core.showEditorGame("inn", true);
      const text = await handoff("inn");
      assert.match(text ?? "", /^\{"key":"[1-9]\d{3,4}\.[0-9a-f]{32}"\}$/, "the shape the Unreal plugin parses");
      const [helperPort, token] = (keyIn(text) ?? "").split(".");
      const models = await fetch(`http://127.0.0.1:${helperPort}/api/runtime/models`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(models.status, 200, "the helper answers a play that carries its token");
      assert.equal(lite.core.previewAi.state("inn").mode, PreviewAiMode.Practice);
      const pids = lite.core.previewAi.runningPids();
      assert.equal(pids.length, 1);
      await lite.core.showEditorGame("inn", false);
      assert.equal(await handoff("inn"), null);
      for (const pid of pids) assert.equal(running(pid), false, "no helper is left once Live left the game");
    } finally {
      await lite.close();
    }
  });

  it("names the helper again when the person changes how the game is answered", async () => {
    const { lite, dirs, handoff } = await studio();
    try {
      await lite.core.showEditorGame("inn", true);
      const before = await handoff("inn");
      await rm(path.join(dirs.inn ?? "", HANDOFF));
      await lite.core.previewAi.backToPractice("inn");
      assert.equal(await handoff("inn"), before, "the bar's Stop names the practice helper to the editor again");
      const refused = await lite.core.previewAi.startRealModels("inn", 100);
      assert.equal(refused.mode, PreviewAiMode.Unavailable, "a test profile never spends");
      assert.equal(await handoff("inn"), before, "practice answers go on");
    } finally {
      await lite.close();
    }
  });

  it("removes the file on Live's Stop and when the app quits", async () => {
    const { lite, handoff } = await studio();
    await lite.core.showEditorGame("inn", true);
    await lite.core.stopLive();
    assert.equal(await handoff("inn"), null, "Stop");
    assert.deepEqual(lite.core.previewAi.runningPids(), []);
    await lite.core.showEditorGame("inn", true);
    const pids = lite.core.previewAi.runningPids();
    assert.equal(pids.length, 1);
    assert.notEqual(await handoff("inn"), null);
    await lite.close();
    assert.equal(await handoff("inn"), null, "quit");
    for (const pid of pids) assert.equal(running(pid), false);
  });

  it("gives an Unreal game whose code calls no model no file, no helper and no bar", async () => {
    const { lite, handoff } = await studio();
    try {
      await lite.core.showEditorGame("inn", true);
      await lite.core.showEditorGame("mill", true);
      assert.equal(await handoff("mill"), null);
      assert.equal(await handoff("inn"), null, "Live left the last game");
      assert.equal(lite.core.previewAi.state("mill").mode, PreviewAiMode.None);
      assert.deepEqual(lite.core.previewAi.runningPids(), []);
    } finally {
      await lite.close();
    }
  });

  it("writes nothing for a name that is no game of this studio", async () => {
    const { lite, dirs } = await studio();
    try {
      for (const name of ["../inn", "inn/../mill", "/etc", "", "nobody"]) {
        await lite.core.showEditorGame(name, true);
        await lite.core.showEditorGame(name, false);
      }
      for (const dir of Object.values(dirs))
        assert.equal(await readFile(path.join(dir, HANDOFF), "utf8").catch(() => null), null);
      assert.deepEqual(lite.core.previewAi.runningPids(), []);
    } finally {
      await lite.close();
    }
  });
});

describe("a web game's Live beside an Unreal game's", () => {
  it("loads a web game as before, and stops its page once its helper goes to an Unreal game", async () => {
    const { lite, port, handoff } = await studio();
    try {
      await lite.core.loadPreview({ project: "web" });
      const key = pageKey(port.loads.at(-1));
      assert.match(key ?? "", /^\d+\.[0-9a-f]{32}$/);
      await lite.core.editorPractice.idle();
      assert.equal(await handoff("web"), null, "a web game is named no helper in its folder");
      await lite.core.showEditorGame("web", true);
      assert.equal(await handoff("web"), null, "nor when its card is asked for: it has no Unreal project");
      assert.equal(port.stopped, 0);
      assert.equal(lite.core.previewAi.runningPids().length, 1, "its page keeps its helper");

      await lite.core.showEditorGame("inn", true);
      assert.equal(port.stopped, 1, "the page's helper went to the Unreal game, so the page stops as Stop stops it");
      assert.notEqual(await handoff("inn"), null);
      await lite.core.playLive();
      const again = pageKey(port.loads.at(-1));
      assert.ok(again && again !== key, "Play serves the page again with a new helper's key");
      await lite.core.editorPractice.idle();
      assert.equal(await handoff("inn"), null, "Live's helper is the page's again");
    } finally {
      await lite.close();
    }
  });

  it("leaves a running page that carries no key alone", async () => {
    const { lite, port, handoff } = await studio();
    try {
      await lite.core.loadPreview({ project: "plain" });
      await lite.core.showEditorGame("inn", true);
      assert.equal(port.stopped, 0);
      assert.notEqual(await handoff("inn"), null);
      await lite.core.loadPreview({ project: "plain" });
      await lite.core.editorPractice.idle();
      assert.notEqual(await handoff("inn"), null, "a page that needs no helper leaves the Unreal game's");
      assert.equal(lite.core.previewAi.runningPids().length, 1);
    } finally {
      await lite.close();
    }
  });
});
