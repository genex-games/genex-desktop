/**
 * Switching a platform off on the Publish card takes that app off Genex: every build Genex holds for
 * the platform goes (`DELETE /api/games/:id/native-builds/:platform/:arch`, the door `genex native
 * remove` uses), the game's other apps stay, and the record forgets the platform so its row says it is
 * not published. Nothing is asked of Genex for a name that is no app platform.
 *
 * GenexTools runs against the fixture Genex API on this machine.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { CLOUD_BUILD_FILE } from "../../src/plugins/genex/cloud-build.ts";
import { CloudBuildState, type GenexPublishState } from "../../src/shared/genex.ts";
import { type GenexFixtureApi, type GenexRequest, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "dust-two";
const SLUG = "dust-two";
const PROJECT_ID = "p-dust";
const SENT_AT = "2026-11-05T10:00:00.000Z";
const servers: GenexFixtureApi[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/** Genex holding the game's Mac app and two Windows builds until they are taken off. */
async function genexWith() {
  const live = [
    { platform: "mac", arch: "universal", version: "3", publishedAt: SENT_AT },
    { platform: "windows", arch: "x64", version: "2", publishedAt: SENT_AT },
    { platform: "windows", arch: "arm64", version: "2", publishedAt: SENT_AT },
  ];
  const requests: GenexRequest[] = [];
  const server = await startGenexFixtureApi((request, reply) => {
    requests.push(request);
    if (request.url === `/api/projects/by-slug/${SLUG}`)
      return reply.json({ project: { id: PROJECT_ID, slug: SLUG, status: "published" } });
    if (request.url === `/api/games/${PROJECT_ID}/native-builds` && request.method === "GET")
      return reply.json({ builds: live, submissions: [] });
    const removal = request.url.match(/^\/api\/games\/p-dust\/native-builds\/([^/]+)\/([^/]+)$/);
    if (removal && request.method === "DELETE") {
      const at = live.findIndex((one) => one.platform === removal[1] && one.arch === removal[2]);
      if (at < 0) return reply.json({ error: "not_found" }, 404);
      live.splice(at, 1);
      return reply.json({ removed: true });
    }
  });
  servers.push(server);
  const removals = () => requests.filter((r) => r.method === "DELETE").map((r) => r.url);
  return { server, removals, live };
}

/** Studio's publish workspace of a game on Genex whose Mac and Windows apps went, Windows built on Genex Cloud. */
async function tools(api: string) {
  const root = await tmpDir("studio-genex-remove-app-");
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
  await writeFile(
    path.join(dir, ".genex", "project.json"),
    JSON.stringify({ slug: SLUG, id: PROJECT_ID, status: "published" }),
  );
  const state: GenexPublishState = { version: 1, project: PROJECT, connected: true };
  await writeFile(path.join(dir, "publish.json"), JSON.stringify(state));
  const sent = (platform: string, arch: string) => ({
    platform,
    arch,
    version: "1",
    sizeBytes: 9,
    publishedAt: SENT_AT,
  });
  await writeFile(
    path.join(dir, "native.json"),
    JSON.stringify({ jobId: "j1", sent: [sent("mac", "universal"), sent("windows", "x64")], failed: [] }),
  );
  const windowsBuild = { platform: "windows", jobId: "job_1", state: CloudBuildState.Done, startedAt: SENT_AT };
  await writeFile(path.join(dir, CLOUD_BUILD_FILE), JSON.stringify({ builds: [windowsBuild] }));
  const read = async (file: string) => JSON.parse(await readFile(path.join(dir, file), "utf8"));
  const signOut = () => {
    token = null;
  };
  return { genex, read, signOut };
}

describe("taking one platform's app off Genex", () => {
  it("removes every build Genex holds for it, keeps the other apps, and forgets it in the record", async () => {
    const { server, removals, live } = await genexWith();
    const { genex, read } = await tools(server.url);
    await genex.publishRemoveApp(PROJECT, "windows");
    assert.deepEqual(removals().sort(), [
      `/api/games/${PROJECT_ID}/native-builds/windows/arm64`,
      `/api/games/${PROJECT_ID}/native-builds/windows/x64`,
    ]);
    assert.deepEqual(
      live.map((one) => one.platform),
      ["mac"],
      "the Mac app stays",
    );
    const native = await read("native.json");
    assert.deepEqual(
      native.sent.map((one: { platform: string }) => one.platform),
      ["mac"],
    );
    assert.deepEqual(
      (await read(CLOUD_BUILD_FILE)).builds,
      [],
      "Genex Cloud's Windows app is no longer what players have",
    );
  });

  it("asks Genex nothing for a name that is no app platform, or while signed out", async () => {
    const { server, removals } = await genexWith();
    const { genex, signOut } = await tools(server.url);
    for (const platform of ["web", "../windows", "", 7, undefined, "WINDOWS"])
      await assert.rejects(genex.publishRemoveApp(PROJECT, platform), String(platform));
    signOut();
    await assert.rejects(genex.publishRemoveApp(PROJECT, "windows"));
    assert.deepEqual(removals(), []);
  });
});
