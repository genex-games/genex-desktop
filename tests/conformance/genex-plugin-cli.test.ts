import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildPlugins } from "../../scripts/build-plugins.mjs";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { buildGenexPluginFor, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { removeTree } from "../helpers/tmp.ts";

/**
 * A `git` in `dir` that has no git-lfs: `git --version` succeeds and `git lfs …` fails. Windows runs
 * no shell script as a command, so there it is a copy of node, which prints its version and fails
 * to load a script named `lfs`.
 */
async function gitWithoutLfs(dir: string) {
  if (process.platform === "win32") {
    await copyFile(process.execPath, path.join(dir, "git.exe"));
    return;
  }
  await writeFile(path.join(dir, "git"), '#!/bin/sh\nif [ "$1" = "lfs" ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
}

test("a worktree with shared dependencies keeps the pinned CLI inside its plugin bundle", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-plugin-linked-"));
  try {
    const checkout = path.join(temp, "checkout"),
      resources = path.join(temp, "resources");
    await mkdir(checkout);
    await symlink(path.join(process.cwd(), "src"), path.join(checkout, "src"), "dir");
    await symlink(await realpath(path.join(process.cwd(), "node_modules")), path.join(checkout, "node_modules"), "dir");
    await buildPlugins(checkout, resources);
    const target = await realpath(path.join(resources, "plugins/genex"));
    const packaged = createRequire(path.join(target, "backend.mjs")).resolve("@genex-ai/cli-demo/package.json");
    assert.equal(packaged, path.join(target, "node_modules/@genex-ai/cli-demo/package.json"));
    assert.equal(JSON.parse(await readFile(packaged, "utf8")).version, "1.36.2");
  } finally {
    await removeTree(temp);
  }
});

test("extracted plugin invokes its packaged pinned CLI; lost submission survives restart without another create", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-plugin-cli-"));
  let creates = 0,
    requestId = "";
  const server = await startGenexFixtureApi(({ method, url, body }, reply) => {
    if (url === "/api/credits/me")
      return reply.json({
        balance: 100,
        spendable: 100,
        reserved: 0,
        unlimited: false,
        prices: { model: 3 },
        budget: { cap: 100 },
      });
    if (url === "/api/generations/lanes")
      return reply.json({ paused: false, lanes: [{ kind: "model", provider: "fixture", mock: false, credit: "ok" }] });
    if (url === "/api/generations/quote") return reply.json({ creditsQuoted: 3 });
    if (url === "/api/generations" && method === "POST") {
      creates++;
      requestId = JSON.parse(body).requestId;
      return reply.json({ error: "lost response" }, 500);
    }
    if (url === `/api/generations/requests/${requestId}` && requestId)
      return reply.json({ id: "existing-plugin-generation", creditsQuoted: 3, status: "pending" });
  });
  const api = server.url;
  let registry: PluginRegistry | undefined;
  try {
    const resources = path.join(temp, "resources");
    await buildGenexPluginFor(resources, api);
    const data = path.join(temp, "data");
    await mkdir(data);
    await writeFile(path.join(data, "settings.json"), JSON.stringify({ enabled: false }));
    let rootReads = 0;
    const service = async (_id: string, method: string) => {
      if (method === "storage.root") {
        rootReads++;
        await new Promise((r) => setTimeout(r, 25));
        return data;
      }
      if (method === "credentials.read") return "synthetic-plugin-token";
      if (method === "events.emit") return true;
      throw new Error("Unexpected service " + method);
    };
    const make = () =>
      new PluginRegistry(
        path.join(temp, "installed"),
        path.join(resources, "plugins"),
        path.join(resources, "plugin-sdk/backend.mjs"),
        service,
      );
    registry = make();
    await registry.init();
    await Promise.all([registry.action("genex", "unlock", {}), registry.action("genex", "status", {})]);
    assert.equal(rootReads, 1);
    const game = path.join(temp, "game");
    await mkdir(game);
    const binding = { project: "fixture", directory: game },
      args = { operation: "model", prompt: "fixture cottage" };
    const connected = await registry.action("genex", "status", {}, binding);
    assert.equal(connected.enabled, true, "sign-in makes assets available without a paid-tools switch");
    assert.equal(
      connected.allowance.allowance.enforced,
      false,
      "Studio uses the CLI supported no-local-allowance mode",
    );
    const nextGame = await registry.action("genex", "status", {}, { ...binding, project: "next-game" });
    assert.equal(nextGame.enabled, true, "a subsequent game needs no new asset enablement");
    assert.equal(nextGame.allowance.allowance.enforced, false, "subsequent games have no hidden allowance gate");
    assert.equal(creates, 0, "status never generates assets");
    assert.ok(
      !registry
        .list()
        .find((p) => p.manifest.id === "genex")
        ?.manifest.actions.some((a) => ["enable-paid", "configure-paid", "allowance"].includes(a.name)),
      "no hidden spending setup actions",
    );
    const first = await registry.tool("genex__asset", args, binding);
    assert.equal(first.status, "unresolved");
    assert.equal(creates, 1);
    registry.cancel();
    registry = make();
    await registry.init();
    await registry.action("genex", "unlock", {});
    const recovered = await registry.tool("genex__asset", args, binding);
    assert.equal(recovered.generationId, "existing-plugin-generation");
    assert.equal(creates, 1);
    assert.ok(
      !(await readFile(path.join(data, "projects/fixture/jobs", first.id, "job.json"), "utf8")).includes(
        "synthetic-plugin-token",
      ),
    );
  } finally {
    registry?.cancel();
    await server.close();
    await removeTree(temp);
  }
});

/**
 * The publish path end to end against the real pinned CLI and a fixture Genex API: one press puts
 * the export on the draft page and makes that build the public version, then a draft on its own.
 * Nothing here leaves the machine — the API is a local http server, the "managed repo" is a bare
 * git repo on disk, and `export.stage` is answered by a stub the way the host answers it. What
 * this pins is where the hosted project lands (Studio's own copy), that the user's game folder
 * stays untouched, and that a second press neither re-creates the project nor re-lists the game.
 */
test("publish creates the hosted project in Studio-owned storage and makes the exported draft public without touching the game", async (t) => {
  const git = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  if (!git) {
    t.skip("git is not installed on this machine; the Genex publish path requires it");
    return;
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-plugin-publish-"));
  let creates = 0,
    listings = 0,
    promotes = 0,
    deploys = 0,
    status = "draft";
  const uploads: string[] = [];
  const hosted = new Map<string, string>();
  let stagingCommitSha = "";
  const bare = path.join(temp, "source.git");
  await mkdir(bare, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git init --bare exited ${code}`))));
  });
  const pushUrl = pathToFileURL(bare).href;
  let api = "";
  const server = await startGenexFixtureApi(({ method, url, body: text }, reply) => {
    if (url.startsWith("/upload/") && method === "PUT") {
      const file = decodeURIComponent(url.slice("/upload/".length));
      uploads.push(file);
      hosted.set(file, text);
      return reply.json({ ok: true });
    }
    if (url.startsWith("/live/")) {
      const file = decodeURIComponent(url.slice("/live/".length).split("?")[0]!);
      const body = hosted.get(file);
      return reply.text(body ?? "missing", body === undefined ? 404 : 200);
    }
    if (url === "/api/projects" && method === "POST") {
      creates++;
      return reply.json({
        project: {
          id: "p1",
          slug: "fixture-game",
          cloneUrl: pushUrl,
          playUrl: "https://fixture-game.genex.technology/",
        },
      });
    }
    if (url === "/api/projects/by-slug/fixture-game")
      return reply.json({ project: { slug: "fixture-game", status, stagingCommitSha } });
    if (url === "/api/projects/p1/push-token" && method === "POST") return reply.json({ pushUrl, managed: true });
    if (url === "/api/projects/p1/publish" && method === "POST") {
      listings++;
      status = "published";
      return reply.json({ ok: true });
    }
    if (url === "/api/games/p1/upload-token" && method === "POST")
      return reply.json({
        token: "fixture-upload-token",
        uploadUrl: `${api}/upload`,
        playUrl: `${api}/live`,
        channels: ["staging", "production"],
        limits: {
          maxFiles: 1000,
          maxFileBytes: 100_000_000,
          maxTotalBytes: 1_000_000_000,
          partSizeBytes: 5_000_000,
          singlePutMaxBytes: 5_000_000,
        },
      });
    if (url === "/api/games/p1/publish" && method === "POST") {
      deploys++;
      stagingCommitSha = JSON.parse(text || "{}").commit;
      return reply.json({ url: `${api}/live`, channel: JSON.parse(text || "{}").channel ?? "production" });
    }
    if (url === "/api/games/p1/promote" && method === "POST") {
      promotes++;
      return reply.json({ commit: "c1", url: `${api}/live` });
    }
    if (url.startsWith("/api/gallery/world/")) return reply.json({ item: null });
  });
  api = server.url;
  const originalPath = process.env.PATH;
  let registry: PluginRegistry | undefined;
  try {
    // The CLI's source push shells out to git-lfs and, when it is missing, tries to install it.
    // A no-op shim in front of PATH keeps the fixture off the network and off Homebrew.
    const shim = path.join(temp, "bin");
    await mkdir(shim, { recursive: true });
    await writeFile(path.join(shim, "git-lfs"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${shim}${path.delimiter}${originalPath ?? ""}`;
    const resources = path.join(temp, "resources");
    await buildGenexPluginFor(resources, api);
    const data = path.join(temp, "data");
    await mkdir(data);
    await writeFile(path.join(data, "settings.json"), JSON.stringify({ enabled: true }));
    const game = path.join(temp, "game");
    await mkdir(game);
    const binding = { project: "fixture", directory: game };
    const service = async (_id: string, method: string, _args: unknown, bound?: { project: string }) => {
      if (method === "storage.root") return data;
      if (method === "credentials.read") return "synthetic-plugin-token";
      if (method === "events.emit") return true;
      if (method === "export.stage") {
        // What the host does: a public copy of the game staged under plugin storage, never in it.
        const target = path.join(data, "publish", String(bound?.project), "dist");
        await mkdir(target, { recursive: true });
        await writeFile(
          path.join(target, "index.html"),
          '<!doctype html><meta charset="utf-8"><title>Fixture game</title><canvas id="game"></canvas>',
        );
        return { dir: target, files: 1, included: ["index.html"], excluded: [] };
      }
      throw new Error("Unexpected service " + method);
    };
    // A Mac with git but without git-lfs. The CLI would install it (`brew install git-lfs`), so
    // publishing is refused here, before the CLI is ever spawned — and nothing is started.
    const nolfs = path.join(temp, "nolfs");
    await mkdir(nolfs, { recursive: true });
    await gitWithoutLfs(nolfs);
    process.env.PATH = nolfs;
    const strict = new PluginRegistry(
      path.join(temp, "installed-nolfs"),
      path.join(resources, "plugins"),
      path.join(resources, "plugin-sdk/backend.mjs"),
      service,
    );
    await strict.init();
    try {
      await strict.action("genex", "unlock", {}, binding);
      await assert.rejects(
        strict.action("genex", "publish-draft", {}, binding),
        /Publishing needs git and git-lfs on this Mac \(brew install git-lfs\)\. Studio will not let the Genex CLI install software\./,
      );
      const refused = await strict.action("genex", "publish-status", { operation: "status" }, binding);
      assert.equal(refused.job, undefined, "a refused publish starts no job");
      assert.equal(creates, 0, "the CLI was never spawned, so no hosted project was created");
      assert.equal(
        await readFile(path.join(data, "publish/fixture/.genex/project.json"), "utf8").then(
          () => true,
          () => false,
        ),
        false,
      );
    } finally {
      strict.cancel();
      process.env.PATH = `${shim}${path.delimiter}${originalPath ?? ""}`;
    }

    registry = new PluginRegistry(
      path.join(temp, "installed"),
      path.join(resources, "plugins"),
      path.join(resources, "plugin-sdk/backend.mjs"),
      service,
    );
    await registry.init();
    await registry.action("genex", "unlock", {}, binding);

    // One press publishes: Studio exports the game, and the CLI puts that build on the draft page
    // and makes the same build the public version, listing the game the first time.
    const first = await registry.action("genex", "publish-gallery", { title: "Fixture Racing" }, binding);
    assert.equal(first.job.state, "running");
    assert.equal(first.job.kind, "gallery");
    const published = await registry.action(
      "genex",
      "publish-status",
      { operation: "wait", jobId: first.job.id },
      binding,
    );
    assert.equal(published.job.state, "done", published.job.error);
    assert.equal(published.job.phase, "ready", published.job.checkError);
    assert.equal(published.slug, "fixture-game");
    assert.equal(published.status, "published");
    assert.equal(published.title, "Fixture Racing", "the dialog's name reaches the listing");
    assert.equal(published.draftUrl, "https://genex.games/draft/fixture-game");
    assert.ok(published.readyDraft, "the draft page serves the published build");
    assert.equal(creates, 1);
    assert.equal(listings, 1);
    assert.equal(promotes, 1);
    assert.equal(deploys, 1, "the draft and the public version are one upload");
    // The hosted identity lives in Studio's copy; the user's game folder learns nothing.
    assert.equal(
      JSON.parse(await readFile(path.join(data, "publish/fixture/.genex/project.json"), "utf8")).slug,
      "fixture-game",
    );
    assert.equal(
      await readFile(path.join(game, ".genex/project.json"), "utf8").then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.deepEqual(uploads.sort(), ["index.html", "studio-deployment.json"]);
    // The token reaches the CLI on fd 3 and must stay there: nothing under Studio's publish
    // workspace — the CLI's own contained HOME included — may hold it in plain text.
    for (const entry of await readdir(path.join(data, "publish"), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const held = await readFile(path.join(entry.parentPath, entry.name), "utf8").catch(() => "");
      assert.ok(!held.includes("synthetic-plugin-token"), `${entry.name} holds the Genex token in plain text`);
    }
    const refs = await new Promise<string>((resolve) => {
      let out = "";
      const child = spawn("git", ["--git-dir", bare, "for-each-ref", "--format=%(refname)"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => resolve(out));
    });
    assert.match(refs, /refs\/heads\/preview/);

    // Publishing a listed game again updates the draft and promotes that build.
    const again = await registry.action("genex", "publish-gallery", {}, binding);
    const updated = await registry.action(
      "genex",
      "publish-status",
      { operation: "wait", jobId: again.job.id },
      binding,
    );
    assert.equal(updated.job.state, "done", updated.job.error);
    assert.equal(updated.job.phase, "ready", updated.job.checkError);
    assert.equal(creates, 1, "publishing again reuses the hosted project instead of creating another");
    assert.equal(listings, 1, "the gallery listing is not repeated");
    assert.equal(promotes, 2);
    assert.equal(deploys, 2);

    // A draft on its own changes only the draft page.
    const drafting = await registry.action("genex", "publish-draft", {}, binding);
    const draft = await registry.action(
      "genex",
      "publish-status",
      { operation: "wait", jobId: drafting.job.id },
      binding,
    );
    assert.equal(draft.job.state, "done", draft.job.error);
    assert.equal(draft.job.phase, "ready", draft.job.checkError);
    assert.equal(draft.status, "published", "the game stays listed");
    assert.equal(promotes, 2, "a draft never replaces the public version");
    assert.equal(deploys, 3);
  } finally {
    process.env.PATH = originalPath;
    registry?.cancel();
    await server.close();
    await removeTree(temp);
  }
});
