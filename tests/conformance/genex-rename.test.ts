/**
 * Renaming a game in the Publish dialog: the name is saved the moment the person finishes typing it.
 * A game already on Genex is renamed there at once (one PATCH of its title, nothing uploaded, no CLI
 * run); a game not on Genex yet keeps the name in its publish record for its first publish. Either
 * way the dialog shows the new name after it closes and opens again.
 *
 * GenexTools runs against the fixture Genex API on this machine.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { createGenexPlugin } from "../../src/plugins/genex/backend.ts";
import { GenexAction, type GenexPublishState } from "../../src/shared/genex.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type GenexFixtureApi, type GenexRequest, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "bodycam-game";
const SLUG = "bodycam-game";
const PROJECT_ID = "p-bodycam";
const servers: GenexFixtureApi[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/** Genex holding the game; `refuse` answers its rename with that status instead. */
async function genexWith(options: { refuse?: number } = {}) {
  const requests: GenexRequest[] = [];
  const server = await startGenexFixtureApi((request, reply) => {
    requests.push(request);
    if (request.url === `/api/projects/by-slug/${SLUG}`) {
      return reply.json({ project: { id: PROJECT_ID, slug: SLUG, status: "published" } });
    }
    if (request.url === `/api/projects/${PROJECT_ID}` && request.method === "PATCH") {
      if (options.refuse) return reply.json({ error: "Forbidden" }, options.refuse);
      const { title } = JSON.parse(request.body) as { title: string };
      return reply.json({ project: { id: PROJECT_ID, slug: SLUG, title } });
    }
  });
  servers.push(server);
  const renames = () => requests.filter((r) => r.method === "PATCH");
  return { server, renames };
}

/** Studio's publish record of the game: on Genex under `title` when `linked`, else never published. */
async function tools(api: string, { linked = true }: { linked?: boolean } = {}) {
  const root = await tmpDir("studio-genex-rename-");
  let token: string | null = "fixture-token";
  const genex = new GenexTools(path.join(root, "host"), api, {
    credentials: {
      get: async () => token,
      set: async (value) => {
        token = value;
      },
      clear: async () => {
        token = null;
      },
    },
  });
  const dir = path.join(genex.root, "publish", PROJECT);
  await mkdir(path.join(dir, ".genex"), { recursive: true });
  if (linked) {
    await writeFile(
      path.join(dir, ".genex", "project.json"),
      JSON.stringify({ slug: SLUG, id: PROJECT_ID, status: "published" }),
    );
  }
  const state: GenexPublishState = { version: 1, project: PROJECT, connected: true, title: "Bodycam game" };
  await writeFile(path.join(dir, "publish.json"), JSON.stringify(state));
  const saved = async () => JSON.parse(await readFile(path.join(dir, "publish.json"), "utf8")) as GenexPublishState;
  const signOut = () => {
    token = null;
  };
  return { genex, saved, signOut };
}

describe("renaming a game from the Publish dialog", () => {
  it("renames a game on Genex there at once, and the dialog shows the new name when it opens again", async () => {
    const { server, renames } = await genexWith();
    const { genex, saved } = await tools(server.url);
    const after = await genex.publishName(PROJECT, "  Street   Patrol ");
    assert.equal(renames().length, 1, "one rename, nothing uploaded");
    assert.equal(renames()[0]?.url, `/api/projects/${PROJECT_ID}`);
    assert.deepEqual(JSON.parse(renames()[0]?.body ?? "{}"), { title: "Street Patrol" });
    assert.equal(renames()[0]?.authorization, "Bearer fixture-token");
    assert.equal(after.title, "Street Patrol");
    assert.equal((await saved()).title, "Street Patrol");
    assert.equal((await genex.publishView(PROJECT)).title, "Street Patrol", "reopened, the dialog reads the new name");
  });

  it("keeps the name of a game not on Genex yet for its first publish, asking Genex nothing", async () => {
    const { server, renames } = await genexWith();
    const { genex, saved } = await tools(server.url, { linked: false });
    await genex.publishName(PROJECT, "Street Patrol");
    assert.equal(renames().length, 0);
    assert.equal((await saved()).title, "Street Patrol");
  });

  it("keeps the old name when Genex refuses the rename, and says so", async () => {
    const { server, renames } = await genexWith({ refuse: 403 });
    const { genex, saved } = await tools(server.url);
    await assert.rejects(genex.publishName(PROJECT, "Street Patrol"));
    assert.equal(renames().length, 1);
    assert.equal((await saved()).title, "Bodycam game");
  });

  it("refuses a name with no letters or digits, and a game on Genex while signed out, saving nothing", async () => {
    const hostile = ["", "   ", "---", "\u0000​", 42, null, { title: "x" }];
    for (const name of hostile) {
      const { server, renames } = await genexWith();
      const { genex, saved } = await tools(server.url);
      await assert.rejects(genex.publishName(PROJECT, name), `refused ${JSON.stringify(name)}`);
      assert.equal(renames().length, 0);
      assert.equal((await saved()).title, "Bodycam game");
    }
    const { server, renames } = await genexWith();
    const signedOut = await tools(server.url);
    signedOut.signOut();
    await assert.rejects(signedOut.genex.publishName(PROJECT, "Street Patrol"));
    assert.equal(renames().length, 0);
    assert.equal((await signedOut.saved()).title, "Bodycam game");
  });

  it("is a Publish dialog action that asks nothing first, so Enter saves", async () => {
    const manifest = validateManifest(
      JSON.parse(await readFile(path.join(process.cwd(), "src/plugins/genex/plugin.json"), "utf8")),
    );
    const declared = manifest.actions.find((a) => a.name === GenexAction.PublishName);
    assert.ok(declared, "declared");
    assert.equal(declared.confirmation, undefined, "no confirmation in front of a rename");
    const { server, renames } = await genexWith();
    const { genex } = await tools(server.url);
    const plugin = await createGenexPlugin(server.url);
    const services: Record<string, unknown> = {
      "storage.root": genex.root,
      "credentials.read": "fixture-token",
      "credentials.session": "fixture-token",
    };
    const ctx = { project: PROJECT, host: async (method: string) => services[method] ?? true };
    const renamed = (await plugin.action(
      GenexAction.PublishName,
      { title: "Street Patrol" },
      ctx,
    )) as GenexPublishState;
    assert.equal(renames().length, 1);
    assert.equal(renamed.title, "Street Patrol");
  });
});
