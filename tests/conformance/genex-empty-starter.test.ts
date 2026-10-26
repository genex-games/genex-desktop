/**
 * Publishing a game that is still Studio's empty starter is refused before anything runs: the
 * starter draws a black screen, so on genex.games it would be a page with nothing to play and a
 * card with no picture. Draft, gallery and the agent's publish tool all refuse it in one plain line,
 * and nothing is exported or sent. The moment the game's own code differs from the starter, the
 * refusal is gone and the publish goes on as before.
 *
 * The plugin runs as it ships (built backend, real registry) against a fixture Genex API on
 * 127.0.0.1. Nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { appendFile, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { MESSAGE as PUBLISH_MESSAGE } from "../../src/plugins/genex/publish.ts";
import { GenexAction } from "../../src/shared/genex.ts";
import { PluginService } from "../../src/shared/plugins.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { buildGenexPluginFor, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "blocks";
const GENEX = "genex";
const TEMPLATE = path.resolve(import.meta.dirname, "../../src/game-template");

/** The Genex plugin as it ships, with a game folder made from Studio's starter, and what it asked of the host. */
async function starterGame(t: { after: (fn: () => unknown) => void }) {
  const temp = await tmpDir("studio-genex-starter-");
  const requests: string[] = [];
  const server = await startGenexFixtureApi(({ url }) => {
    requests.push(url);
  });
  const resources = path.join(temp, "resources");
  await buildGenexPluginFor(resources, server.url);
  const data = path.join(temp, "data");
  const game = path.join(temp, PROJECT);
  await mkdir(data);
  await cp(TEMPLATE, game, { recursive: true });
  const asked: string[] = [];
  const service = async (_id: string, method: string) => {
    asked.push(method);
    if (method === PluginService.StorageRoot) return data;
    if (method === PluginService.CredentialsSession) return null;
    if (method === PluginService.EventsEmit) return true;
    throw new Error(`unexpected service ${method}`);
  };
  const registry = new PluginRegistry(
    path.join(temp, "installed"),
    path.join(resources, "plugins"),
    path.join(resources, "plugin-sdk/backend.mjs"),
    service,
  );
  registry.consent = async () => ({ approved: true, by: "user" });
  await registry.init();
  t.after(async () => {
    registry.cancel();
    await server.close();
  });
  return { registry, game, asked, requests, binding: { project: PROJECT, directory: game } };
}

describe("an empty starter is not published", () => {
  for (const action of [GenexAction.PublishGallery, GenexAction.PublishDraft]) {
    it(`refuses ${action} in one plain line, exporting and sending nothing`, async (t) => {
      const host = await starterGame(t);
      await assert.rejects(
        host.registry.action(GENEX, action, {}, host.binding),
        (error: Error) => error.message === PUBLISH_MESSAGE.EmptyStarterRefusal(),
      );
      assert.ok(!host.asked.includes(PluginService.ExportStage), "the game was never exported");
      assert.deepEqual(host.requests, [], "nothing reached Genex");
    });
  }

  it("refuses the agent's publish tool too, in the agent's words", async (t) => {
    const host = await starterGame(t);
    await assert.rejects(host.registry.tool("genex__publish", { operation: "gallery" }, host.binding), (error: Error) =>
      error.message.includes(PUBLISH_MESSAGE.EmptyStarter),
    );
    assert.ok(!host.asked.includes(PluginService.ExportStage));
    assert.deepEqual(host.requests, []);
  });

  it("lets a game whose own code moved on from the starter go on to publish", async (t) => {
    const host = await starterGame(t);
    await appendFile(path.join(host.game, "src", "main.js"), "\nconsole.log('a game');\n");
    await assert.rejects(
      host.registry.action(GENEX, GenexAction.PublishGallery, {}, host.binding),
      (error: Error) => error.message === PUBLISH_MESSAGE.ConnectFirstRefusal(),
      "past the starter check, it stops only where any publish without an account stops",
    );
  });
});
