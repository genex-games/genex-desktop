/**
 * A published game used to load on genex.games and then show "This game didn't finish starting":
 * Studio runs the Genex CLI in its own copy of the game, which had no package.json, so the CLI
 * never told Genex the game uses sign-in (`embedSdkVersion`). It was also listed under its folder
 * name, which Genex painted on its cover, and nothing was tested before players got it.
 *
 * Now Studio's copy carries the game's Genex packages, every publish uploads the draft, tests it
 * there and only then makes it public and lists it under the name the person chose. A draft that
 * fails its test is uploaded once more, and if it fails again nothing goes public.
 *
 * GenexTools runs the real pinned CLI against a fixture Genex API on 127.0.0.1; the managed source
 * repo is a bare git repo on disk. Nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { MESSAGE as PUBLISH_MESSAGE } from "../../src/plugins/genex/publish.ts";
import { cleanGenexTitle, defaultGenexTitle, type GenexGameManifest } from "../../src/shared/genex.ts";
import { genexGameManifest, readGenexGameManifest } from "../../src/substrate/genex-game-manifest.ts";
import { startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "racing-demo";
const SLUG = "racing-demo";
const SIGN_IN = "0.30.0";
const SIGN_IN_GAME: GenexGameManifest = { dependencies: { "@genex-ai/embed-sdk": SIGN_IN } };
/** A test window short enough for a failing draft to give up at once. */
const QUICK_TEST_MS = 50;

const run = (command: string, args: string[]) =>
  new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

let hasGit = false;
const originalPath = process.env.PATH;
before(async () => {
  hasGit = await run("git", ["--version"]);
  // The CLI's source push shells out to git-lfs and tries to install it when it is missing.
  const shim = await tmpDir("studio-genex-gate-bin-");
  await writeFile(path.join(shim, "git-lfs"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PATH = `${shim}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  process.env.PATH = originalPath;
});

/** What the fixture saw, in order: deploys (with their bodies), draft tests, promotions and listings. */
interface Seen {
  events: string[];
  deploys: Array<Record<string, unknown>>;
  listings: Array<Record<string, unknown>>;
}

/**
 * A fixture Genex for one hosted game. `broken` serves a stale deployment marker, so the draft
 * test never passes; `failFirstDeploy` answers the first deploy with a 500 before anything lands.
 */
async function genexFixture(options: { broken?: boolean; failFirstDeploy?: boolean } = {}) {
  const temp = await tmpDir("studio-genex-gate-");
  const bare = path.join(temp, "source.git");
  await mkdir(bare, { recursive: true });
  assert.ok(await run("git", ["init", "--bare", "-q", bare]));
  const pushUrl = pathToFileURL(bare).href;
  const seen: Seen = { events: [], deploys: [], listings: [] };
  const hosted = new Map<string, string>();
  let status = "draft",
    stagingCommitSha = "",
    embedSdkVersion: string | undefined,
    deployAttempts = 0,
    api = "";
  const note = (event: string) => {
    if (seen.events.at(-1) !== event) seen.events.push(event);
  };
  const server = await startGenexFixtureApi(({ method, url, body }, reply) => {
    if (url.startsWith("/upload/") && method === "PUT") {
      hosted.set(decodeURIComponent(url.slice("/upload/".length)), body);
      return reply.json({ ok: true });
    }
    if (url.startsWith("/live/")) {
      note("test");
      const file = decodeURIComponent(url.slice("/live/".length).split("?")[0] ?? "");
      if (options.broken && file === "studio-deployment.json") return reply.text('{"id":"old","digest":"old"}');
      const served = hosted.get(file);
      return reply.text(served ?? "missing", served === undefined ? 404 : 200);
    }
    if (url === "/api/projects" && method === "POST")
      return reply.json({
        project: { id: "p1", slug: SLUG, cloneUrl: pushUrl, playUrl: "https://racing-demo.genex.technology/" },
      });
    if (url === `/api/projects/by-slug/${SLUG}`)
      return reply.json({ project: { slug: SLUG, status, stagingCommitSha, embedSdkVersion } });
    if (url === "/api/projects/p1/push-token" && method === "POST") return reply.json({ pushUrl, managed: true });
    if (url === "/api/projects/p1/publish" && method === "POST") {
      note("list");
      seen.listings.push(JSON.parse(body || "{}"));
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
      deployAttempts++;
      if (options.failFirstDeploy && deployAttempts === 1) return reply.json({ error: "unavailable" }, 500);
      const deploy = JSON.parse(body || "{}");
      note(`deploy:${deploy.channel}`);
      seen.deploys.push(deploy);
      stagingCommitSha = deploy.commit;
      if (typeof deploy.embedSdkVersion === "string") embedSdkVersion = deploy.embedSdkVersion;
      return reply.json({ url: `${api}/live`, channel: deploy.channel ?? "production" });
    }
    if (url === "/api/games/p1/promote" && method === "POST") {
      note("promote");
      return reply.json({ commit: stagingCommitSha, url: `${api}/live` });
    }
    if (url.startsWith("/api/gallery/world/")) return reply.json({ item: null });
  });
  api = server.url;
  const game = path.join(temp, "game");
  await mkdir(game);
  const genex = new GenexTools(path.join(temp, "host"), api, {
    credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
    draftTestMs: QUICK_TEST_MS,
  });
  const workspace = path.join(genex.root, "publish", PROJECT);
  /** What the host's `export.stage` answers: the public copy, and what the game's package.json says. */
  const exportStage = (manifest?: GenexGameManifest) => async () => {
    const dist = path.join(workspace, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.html"), '<!doctype html><meta charset="utf-8"><title>Racing</title>');
    return { dir: dist, files: 1, included: ["index.html"], excluded: [], ...(manifest ? { genex: manifest } : {}) };
  };
  /** Publish under `title`; `manifest` null is a game whose package.json names no Genex package. */
  const publish = async (title?: string, manifest: GenexGameManifest | null = SIGN_IN_GAME) => {
    const started = await genex.publishGallery(PROJECT, exportStage(manifest ?? undefined), title);
    return genex.publishWait(PROJECT, started.job?.id);
  };
  return { genex, server, seen, workspace, game, publish, close: () => server.close() };
}

describe("publishing tests the build before players get it", () => {
  it("tells Genex the game uses sign-in, tests the draft, then makes it public under the chosen name", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      const done = await fx.publish("Racing Demo");
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal(done.job?.phase, "ready", done.job?.checkError);
      assert.equal(fx.seen.deploys[0]?.embedSdkVersion, SIGN_IN, "the upload names the sign-in support it ships");
      assert.deepEqual(fx.seen.events, ["deploy:staging", "test", "promote", "list"], "nothing is public untested");
      assert.equal(fx.seen.deploys.length, 1, "the draft and the public version are one upload");
      assert.equal(fx.seen.listings[0]?.title, "Racing Demo");
      assert.equal(fx.seen.listings[0]?.regenerateCover, undefined, "a first listing draws its cover anyway");
      assert.equal(done.title, "Racing Demo");
      assert.equal(done.status, "published");
      const copy = JSON.parse(await readFile(path.join(fx.workspace, "package.json"), "utf8"));
      assert.deepEqual(copy.dependencies, { "@genex-ai/embed-sdk": SIGN_IN });
      await assert.rejects(readFile(path.join(fx.game, "package.json")), "the game folder is never written");
    } finally {
      await fx.close();
    }
  });

  it("lists a listed game again only when its name changes, and then redraws its cover", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      await fx.publish("Racing Demo");
      const same = await fx.publish();
      assert.equal(same.job?.state, "done", same.job?.error);
      assert.equal(fx.seen.listings.length, 1, "an update keeps its name and is not listed again");
      const renamed = await fx.publish("Rain Circuit");
      assert.equal(renamed.job?.state, "done", renamed.job?.error);
      assert.equal(fx.seen.listings.length, 2);
      assert.equal(fx.seen.listings[1]?.title, "Rain Circuit");
      assert.equal(fx.seen.listings[1]?.regenerateCover, true, "the old name is painted on the old cover");
      assert.equal(renamed.title, "Rain Circuit");
    } finally {
      await fx.close();
    }
  });

  it("uploads a draft that fails its test once more, and then makes nothing public", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture({ broken: true });
    try {
      const failed = await fx.publish("Racing Demo");
      assert.equal(failed.job?.state, "failed");
      assert.equal(failed.job?.error, PUBLISH_MESSAGE.DraftFailedTest);
      assert.equal(fx.seen.deploys.length, 2, "one more upload before giving up");
      assert.ok(!fx.seen.events.includes("promote"), "the untested build never replaced the public one");
      assert.ok(!fx.seen.events.includes("list"));
      assert.equal(failed.status, "draft");
      assert.equal(failed.readyDraft, undefined);
    } finally {
      await fx.close();
    }
  });

  it("quietly uploads again when an upload failed before anything reached Genex", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture({ failFirstDeploy: true });
    try {
      const done = await fx.publish("Racing Demo");
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal(done.job?.uploads, 2);
      assert.deepEqual(fx.seen.events, ["deploy:staging", "test", "promote", "list"]);
    } finally {
      await fx.close();
    }
  });

  it("leaves no package.json in Studio's copy for a game that names no Genex package", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      await fx.publish("Racing Demo");
      const plain = await fx.publish(undefined, null);
      assert.equal(plain.job?.state, "done", plain.job?.error);
      assert.equal(fx.seen.deploys[1]?.embedSdkVersion, undefined);
      await assert.rejects(readFile(path.join(fx.workspace, "package.json")), "the earlier copy's manifest is gone");
    } finally {
      await fx.close();
    }
  });
});

describe("a publish a restart stopped while its draft was tested", () => {
  it("is over, not unknown: the draft was uploaded and nothing was made public", async () => {
    const root = await tmpDir("studio-genex-gate-restart-");
    const genex = new GenexTools(path.join(root, "host"), "http://127.0.0.1:9", {
      credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
    });
    const dir = path.join(genex.root, "publish", PROJECT);
    await mkdir(dir, { recursive: true });
    const job = {
      id: "testing",
      kind: "gallery",
      state: "running",
      phase: "verifying-deployment",
      startedAt: "2026-10-06T10:00:00.000Z",
    };
    await writeFile(
      path.join(dir, "publish.json"),
      JSON.stringify({ version: 1, project: PROJECT, connected: true, job }),
    );
    const after = await genex.publishStatus(PROJECT);
    assert.equal(after.job?.state, "failed");
    assert.equal(after.job?.error, PUBLISH_MESSAGE.OnlyDraftUpdated);
  });
});

describe("what a game's package.json tells Genex", () => {
  it("keeps only the Genex SDK versions and settings, and drops anything else or malformed", () => {
    const table: Array<[string, unknown, GenexGameManifest | undefined]> = [
      ["not an object", "[]", undefined],
      ["no Genex package", { dependencies: { three: "^0.170.0" } }, undefined],
      ["sign-in", { dependencies: { "@genex-ai/embed-sdk": "0.30.0", three: "1" } }, SIGN_IN_GAME],
      [
        "dev dependency",
        { devDependencies: { "@genex-ai/multiplayer": "^0.16.1" } },
        { dependencies: { "@genex-ai/multiplayer": "^0.16.1" } },
      ],
      ["a path, not a version", { dependencies: { "@genex-ai/embed-sdk": "file:../../etc" } }, undefined],
      ["a URL, not a version", { dependencies: { "@genex-ai/embed-sdk": "https://x.invalid/sdk.tgz" } }, undefined],
      ["a number", { dependencies: { "@genex-ai/embed-sdk": 30 } }, undefined],
      ["inherited name", JSON.parse('{"dependencies":{"__proto__":{"@genex-ai/embed-sdk":"1"}}}'), undefined],
      [
        "matchmaking",
        { genex: { matchmaking: { preset: "duel" } } },
        { dependencies: {}, genex: { matchmaking: { preset: "duel" } } },
      ],
      ["matchmaking as a list", { genex: { matchmaking: ["duel"] } }, undefined],
      ["oversized matchmaking", { genex: { matchmaking: { preset: "x".repeat(5000) } } }, undefined],
      [
        "mobile controls",
        { genex: { mobileControls: true, agentProfile: "remix" } },
        { dependencies: {}, genex: { mobileControls: true } },
      ],
      ["mobile controls as text", { genex: { mobileControls: "yes" } }, undefined],
    ];
    for (const [name, pkg, expected] of table) assert.deepEqual(genexGameManifest(pkg), expected, name);
  });

  it("reads only a package.json that really lives in the game, and never follows a link out of it", async () => {
    const root = await tmpDir("studio-genex-manifest-");
    const game = path.join(root, "game");
    const outside = path.join(root, "outside");
    await mkdir(game);
    await mkdir(outside);
    assert.equal(await readGenexGameManifest(game), undefined, "no package.json");
    await writeFile(path.join(game, "package.json"), "{ not json");
    assert.equal(await readGenexGameManifest(game), undefined, "unparsable");
    await writeFile(
      path.join(game, "package.json"),
      JSON.stringify({ dependencies: { "@genex-ai/embed-sdk": SIGN_IN } }),
    );
    assert.deepEqual(await readGenexGameManifest(game), SIGN_IN_GAME);
    await writeFile(path.join(game, "package.json"), " ".repeat(300 * 1024));
    assert.equal(await readGenexGameManifest(game), undefined, "too large");
    const linked = path.join(root, "linked");
    await mkdir(linked);
    await writeFile(
      path.join(outside, "package.json"),
      JSON.stringify({ dependencies: { "@genex-ai/embed-sdk": "9" } }),
    );
    await symlink(path.join(outside, "package.json"), path.join(linked, "package.json"));
    assert.equal(await readGenexGameManifest(linked), undefined, "a link out of the game");
    await mkdir(path.join(root, "dir-game", "package.json"), { recursive: true });
    assert.equal(await readGenexGameManifest(path.join(root, "dir-game")), undefined, "a folder named package.json");
  });
});

describe("the name a game is listed under", () => {
  it("is offered from its folder name, as words", () => {
    assert.equal(defaultGenexTitle("hyper-realistic-racing-demo"), "Hyper Realistic Racing Demo");
    assert.equal(defaultGenexTitle("rain_circuit"), "Rain Circuit");
  });

  it("is one clean line within the cap, or nothing", () => {
    const table: Array<[unknown, string | null]> = [
      ["  Racing   Demo ", "Racing Demo"],
      ["Line\nbreak\ttab", "Line break tab"],
      ["--title", "title"],
      ["   ", null],
      ["---", null],
      [42, null],
      ["‮evil", "evil"],
      ["x".repeat(80), "x".repeat(60)],
    ];
    for (const [input, expected] of table) assert.equal(cleanGenexTitle(input), expected, JSON.stringify(input));
  });
});
