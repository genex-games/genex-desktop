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

/**
 * Genex holding the game, an apps-only game (no web build) listed as "Bodycam game". `refuse` answers
 * its rename with that status instead; `link` answers its link change with that status and code.
 */
async function genexWith(options: { refuse?: number; link?: { status: number; error: string } } = {}) {
  const requests: GenexRequest[] = [];
  const hosted = { slug: SLUG, title: "Bodycam game", renamesLeft: 2 as number | null };
  const server = await startGenexFixtureApi((request, reply) => {
    requests.push(request);
    if (request.url === `/api/projects/by-slug/${hosted.slug}`) {
      return reply.json({ project: { id: PROJECT_ID, status: "published", commitSha: null, ...hosted } });
    }
    if (request.url === `/api/projects/${PROJECT_ID}` && request.method === "PATCH") {
      if (options.refuse) return reply.json({ error: "Forbidden" }, options.refuse);
      hosted.title = (JSON.parse(request.body) as { title: string }).title;
      return reply.json({ project: { id: PROJECT_ID, ...hosted } });
    }
    if (request.url === `/api/projects/${PROJECT_ID}/rename` && request.method === "POST") {
      if (options.link) return reply.json({ error: options.link.error }, options.link.status);
      hosted.slug = (JSON.parse(request.body) as { name: string }).name;
      hosted.renamesLeft = (hosted.renamesLeft ?? 1) - 1;
      const playUrl = `https://${hosted.slug}.genex.technology/`;
      return reply.json({ project: { id: PROJECT_ID, ...hosted, playUrl }, renamed: true });
    }
  });
  servers.push(server);
  const renames = () => requests.filter((r) => r.method === "PATCH");
  const moves = () => requests.filter((r) => r.url.endsWith("/rename"));
  return { server, renames, moves, hosted };
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
  const link = async () => JSON.parse(await readFile(path.join(dir, ".genex", "project.json"), "utf8"));
  const signOut = () => {
    token = null;
  };
  return { genex, saved, link, signOut };
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

describe("changing a game's link from the Publish dialog", () => {
  it("moves the game to the link as Genex spells it, and the dialog and the game's link follow", async () => {
    const { server, moves } = await genexWith();
    const { genex, saved, link } = await tools(server.url);
    assert.equal((await genex.publishView(PROJECT)).renamesLeft, 2, "the dialog knows the changes left");
    const after = await genex.publishLink(PROJECT, "  Street Patrol!! ");
    assert.equal(moves().length, 1);
    assert.deepEqual(JSON.parse(moves()[0]?.body ?? "{}"), { name: "street-patrol" });
    assert.equal(after.slug, "street-patrol");
    assert.equal(after.galleryUrl, "https://genex.games/street-patrol");
    assert.equal(after.renamesLeft, 1);
    assert.equal((await saved()).slug, "street-patrol");
    assert.equal((await link()).slug, "street-patrol", "the next publish goes to the new link");
    assert.equal((await link()).id, PROJECT_ID, "the same game, not a new one");
  });

  it("sends nothing for the link the game already has", async () => {
    const { server, moves } = await genexWith();
    const { genex } = await tools(server.url);
    assert.equal((await genex.publishLink(PROJECT, "Bodycam Game")).slug, SLUG);
    assert.equal(moves().length, 0);
  });

  it("says why Genex refused, keeping the old link", async () => {
    const cases = [
      { answer: { status: 409, error: "slug already taken" }, words: /Another game already has this link/ },
      { answer: { status: 409, error: "rename_limit_reached" }, words: /used all its link changes/ },
      { answer: { status: 400, error: "slug is reserved" }, words: /Genex keeps this link/ },
    ];
    for (const { answer, words } of cases) {
      const { server } = await genexWith({ link: answer });
      const { genex, saved, link } = await tools(server.url);
      await assert.rejects(genex.publishLink(PROJECT, "street-patrol"), words);
      assert.equal((await link()).slug, SLUG);
      assert.notEqual((await saved()).slug, "street-patrol");
    }
  });

  it("refuses a link with no letter or digit, a game not on Genex and a signed-out Studio, sending nothing", async () => {
    for (const hostile of ["", "---", "!!!", "\u00e9\u00e9", 7, null, { link: "x" }]) {
      const { server, moves } = await genexWith();
      const { genex, link } = await tools(server.url);
      await assert.rejects(genex.publishLink(PROJECT, hostile), `refused ${JSON.stringify(hostile)}`);
      assert.equal(moves().length, 0);
      assert.equal((await link()).slug, SLUG);
    }
    const { server, moves } = await genexWith();
    const unlinked = await tools(server.url, { linked: false });
    await assert.rejects(unlinked.genex.publishLink(PROJECT, "street-patrol"), /Nothing is online/);
    const signedOut = await tools(server.url);
    signedOut.signOut();
    await assert.rejects(signedOut.genex.publishLink(PROJECT, "street-patrol"));
    assert.equal(moves().length, 0);
  });

  it("shows the name Genex lists the game under, renamed on its page or here", async () => {
    const { server, hosted } = await genexWith();
    const { genex } = await tools(server.url);
    hosted.title = "Renamed On Its Page";
    assert.equal((await genex.publishView(PROJECT)).hostedTitle, "Renamed On Its Page");
    await genex.publishName(PROJECT, "Street Patrol");
    assert.equal((await genex.publishView(PROJECT)).hostedTitle, "Street Patrol", "read again after a rename");
  });
});
