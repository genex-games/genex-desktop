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
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { bringsOwnSdk } from "../../src/plugins/genex/entry-page.ts";
import { MESSAGE as PUBLISH_MESSAGE } from "../../src/plugins/genex/publish.ts";
import {
  cleanGenexTitle,
  defaultGenexTitle,
  GENEX_EMBED_VENDOR,
  GENEX_GAME_PACKAGES,
  type GenexGameManifest,
  studioSdkImports,
} from "../../src/shared/genex.ts";
import {
  genexGameManifest,
  readGenexGameManifest,
  usesGenexMultiplayer,
} from "../../src/substrate/genex-game-manifest.ts";
import { PluginService } from "../../src/shared/plugins.ts";
import { clearStagedRoom, roomModulePath, stageRoom } from "../../src/substrate/genex-room-stage.ts";
import { PluginServices } from "../../src/substrate/plugins/services.ts";
import { startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "racing-demo";
const SLUG = "racing-demo";
const SIGN_IN = "0.30.0";
const SIGN_IN_GAME: GenexGameManifest = { dependencies: { "@genex-ai/embed-sdk": SIGN_IN } };
/** The embed SDK Studio ships with a game that brings none of its own. */
const STUDIO_SDK = GENEX_GAME_PACKAGES["@genex-ai/embed-sdk"];
/** A page as Studio's template writes it: no `<head>` tag, three.js through an import map. */
const TEMPLATE_PAGE = [
  "<!doctype html>",
  '<meta charset="utf-8" />',
  "<title>Racing</title>",
  '<script type="importmap">{"imports":{"three":"./vendor/three.module.js"}}</script>',
  '<script type="module" src="./src/main.js"></script>',
].join("\n");
/** A page with no import map and no head tag. */
const BARE_PAGE = '<!doctype html><meta charset="utf-8"><title>Racing</title>';
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
  /** Room modules stored in Genex's private module store, by sha256: the module's text. */
  modules: Map<string, string>;
  /** Room modules released on their own (`authority-release`), with their bodies. */
  releases: Array<Record<string, unknown>>;
  /** Apps made live (`native-builds`), with their bodies. */
  apps: Array<Record<string, unknown>>;
}

/**
 * A fixture Genex for one hosted game. `broken` serves a stale deployment marker, so the draft
 * test never passes; `failFirstDeploy` answers the first deploy with a 500 before anything lands.
 * As Genex does, the project records sign-in support only for the build players get: a draft
 * upload keeps it with the draft, and promoting the draft makes it the project's.
 */
async function genexFixture(options: { broken?: boolean; failFirstDeploy?: boolean } = {}) {
  const temp = await tmpDir("studio-genex-gate-");
  const bare = path.join(temp, "source.git");
  await mkdir(bare, { recursive: true });
  assert.ok(await run("git", ["init", "--bare", "-q", bare]));
  const pushUrl = pathToFileURL(bare).href;
  const seen: Seen = { events: [], deploys: [], listings: [], modules: new Map(), releases: [], apps: [] };
  const hosted = new Map<string, string>();
  let status = "draft",
    stagingCommitSha = "",
    embedSdkVersion: string | null = null,
    draftEmbedSdkVersion: string | undefined,
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
    if (url === "/api/games/p1/authority-module" && method === "POST") {
      const asked = JSON.parse(body || "{}");
      const signed = (what: string, bytes: number) => ({
        url: `${api}/authority/${what}/${asked.sha256}`,
        headers: { "Content-Length": String(bytes) },
      });
      return reply.json({ module: signed("module", asked.bytes), report: signed("report", asked.reportBytes) });
    }
    if (url.startsWith("/authority/module/") && method === "PUT") {
      seen.modules.set(url.slice("/authority/module/".length), body);
      return reply.json({ ok: true });
    }
    if (url.startsWith("/authority/report/") && method === "PUT") return reply.json({ ok: true });
    if (url === "/api/games/p1/authority-release" && method === "POST") {
      const release = JSON.parse(body || "{}");
      note("release");
      seen.releases.push(release);
      const sha = release.authority?.moduleSha256;
      return reply.json({ channel: release.channel, authority: sha ? { moduleSha256: sha } : null });
    }
    if (url === "/api/games/p1/native-upload-token" && method === "POST")
      return reply.json({
        token: "fixture-native-token",
        uploadUrl: `${api}/native-upload`,
        uploadPath: "p1/app.zip",
        // Genex already holds these bytes: nothing goes up, as for an app sent before.
        uploaded: true,
        limits: { maxArchiveBytes: 1_000_000_000, partSizeBytes: 5_000_000, singlePutMaxBytes: 5_000_000 },
      });
    if (url === "/api/games/p1/native-builds" && method === "POST") {
      const app = JSON.parse(body || "{}");
      note("app");
      seen.apps.push(app);
      const build = { ...app, url: `${api}/apps/${app.platform}`, publishedAt: "2026-11-10T00:00:00.000Z" };
      return reply.json({ build: { ...build, review: "approved" } });
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
      if (typeof deploy.embedSdkVersion === "string") draftEmbedSdkVersion = deploy.embedSdkVersion;
      const authority = deploy.authority ? { authority: { moduleSha256: deploy.authority.moduleSha256 } } : {};
      return reply.json({ url: `${api}/live`, channel: deploy.channel ?? "production", ...authority });
    }
    if (url === "/api/games/p1/promote" && method === "POST") {
      note("promote");
      if (draftEmbedSdkVersion) embedSdkVersion = draftEmbedSdkVersion;
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
  const exportStage =
    (manifest?: GenexGameManifest, page = BARE_PAGE) =>
    async () => {
      const dist = path.join(workspace, "dist");
      await mkdir(dist, { recursive: true });
      await writeFile(path.join(dist, "index.html"), page);
      return { dir: dist, files: 1, included: ["index.html"], excluded: [], ...(manifest ? { genex: manifest } : {}) };
    };
  /** Publish `page` under `title`; `manifest` null is a game whose package.json names no Genex package. */
  const publish = async (title?: string, manifest: GenexGameManifest | null = SIGN_IN_GAME, page?: string) => {
    const started = await genex.publishGallery(PROJECT, exportStage(manifest ?? undefined, page), title);
    return genex.publishWait(PROJECT, started.job?.id);
  };
  /** Put the game on its draft page only, and wait until that draft passes its test or fails it. */
  const draft = async (manifest: GenexGameManifest = SIGN_IN_GAME) => {
    const started = await genex.publishDraft(PROJECT, exportStage(manifest));
    return genex.publishWait(PROJECT, started.job?.id);
  };
  /** The sign-in support Genex records for the project: the public build's. */
  const recordedSignIn = () => embedSdkVersion;
  return { genex, server, seen, hosted, workspace, game, publish, draft, recordedSignIn, close: () => server.close() };
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
      assert.equal(fx.recordedSignIn(), SIGN_IN, "and Genex records it once the draft is promoted");
      assert.deepEqual(fx.seen.events, ["deploy:staging", "test", "promote", "list"], "nothing is public untested");
      assert.equal(fx.seen.deploys.length, 1, "the draft and the public version are one upload");
      assert.equal(fx.seen.listings[0]?.title, "Racing Demo");
      assert.equal(fx.seen.listings[0]?.regenerateCover, undefined, "Studio never asks Genex to paint a cover");
      assert.equal(done.title, "Racing Demo");
      assert.equal(done.status, "published");
      const copy = JSON.parse(await readFile(path.join(fx.workspace, "package.json"), "utf8"));
      assert.deepEqual(copy.dependencies, { "@genex-ai/embed-sdk": SIGN_IN });
      await assert.rejects(readFile(path.join(fx.game, "package.json")), "the game folder is never written");
    } finally {
      await fx.close();
    }
  });

  it("passes a sign-in game's first draft, whose sign-in support Genex keeps with the draft until it goes public", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      const done = await fx.draft();
      assert.equal(done.job?.phase, "ready", done.job?.checkError);
      assert.ok(done.readyDraft, "the draft is recorded as tested");
      assert.equal(fx.seen.deploys[0]?.embedSdkVersion, SIGN_IN);
      assert.equal(fx.recordedSignIn(), null, "nothing is public, so the project records no sign-in support yet");
      assert.ok(!fx.seen.events.includes("promote"));
    } finally {
      await fx.close();
    }
  });

  it("lists a listed game again only when its name changes, and never asks Genex to repaint its cover", async (t) => {
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
      assert.equal(
        fx.seen.listings[1]?.regenerateCover,
        undefined,
        "a cover is a real frame of the game with no name on it: a rename leaves it as it is",
      );
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

  it("tells Genex a game that names no Genex package signs in through the SDK Studio ships with it", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      await fx.publish("Racing Demo", { dependencies: { "@genex-ai/multiplayer": "0.17.0" } });
      const plain = await fx.publish(undefined, null);
      assert.equal(plain.job?.state, "done", plain.job?.error);
      assert.equal(fx.seen.deploys[1]?.embedSdkVersion, STUDIO_SDK);
      const copy = JSON.parse(await readFile(path.join(fx.workspace, "package.json"), "utf8"));
      assert.deepEqual(
        copy.dependencies,
        { "@genex-ai/embed-sdk": STUDIO_SDK },
        "the earlier copy's packages are gone",
      );
    } finally {
      await fx.close();
    }
  });
});

/** The relative modules `file` imports, and theirs, as paths beside it. */
function moduleGraph(hosted: Map<string, string>, file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, ref = ""] of (hosted.get(file) ?? "").matchAll(/\bfrom\s*["'](\.[^"']+)["']/g))
    moduleGraph(hosted, path.posix.join(path.posix.dirname(file), ref), seen);
  return seen;
}

describe("a published game connects to Genex as it boots", () => {
  const connect = `vendor/${GENEX_EMBED_VENDOR.Connect}`;
  const tag = `<script type="module" src="./${connect}"></script>`;

  it("ships a game that brings no SDK with Studio's, connected to the project its first publish created", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      const done = await fx.publish("Racing Demo", null, TEMPLATE_PAGE);
      assert.equal(done.job?.state, "done", done.job?.error);
      const page = fx.hosted.get("index.html") ?? "";
      assert.match(page, /^<!doctype html>/, "the doctype stays first, so the page renders in standards mode");
      assert.match(page, /<head>[\s\S]*<\/head>/, "a head the games host can put its environment into");
      const importMapEnd = page.indexOf("</script>", page.indexOf('type="importmap"'));
      const connectAt = page.indexOf(tag);
      assert.ok(connectAt > importMapEnd, "connected after the import map, which must come before any module");
      assert.ok(connectAt < page.indexOf('src="./src/main.js"'), "and before the game's own code runs");
      const script = fx.hosted.get(connect) ?? "";
      assert.match(script, /import \{ [^}]*\binitEmbed\b[^}]* \} from "\.\/embed-sdk\/index\.js"/);
      assert.match(script, new RegExp(`slug: "${SLUG}"`), "the project the first publish created");
      const sdk = moduleGraph(fx.hosted, `vendor/${GENEX_EMBED_VENDOR.Entry}`);
      for (const file of sdk) assert.ok(fx.hosted.has(file), `${file} is uploaded`);
      assert.ok(sdk.size > 1, "the SDK's chunks go up with its entry");
      assert.equal(fx.seen.deploys[0]?.embedSdkVersion, STUDIO_SDK, "Genex records the sign-in support it ships");
      await assert.rejects(readFile(path.join(fx.game, "index.html")), "the game folder is never written");
    } finally {
      await fx.close();
    }
  });

  it("leaves a game that ships its own SDK to connect itself", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      const done = await fx.publish("Racing Demo", SIGN_IN_GAME, TEMPLATE_PAGE);
      assert.equal(done.job?.state, "done", done.job?.error);
      const page = fx.hosted.get("index.html") ?? "";
      assert.ok(!page.includes(connect), "one SDK answers the site, never two");
      assert.ok(![...fx.hosted.keys()].some((file) => file.startsWith("vendor/genex/")));
      assert.match(page, /^<!doctype html>\n?<head><meta name="studio-deployment"/, "its page still gets a head");
      assert.equal(fx.seen.deploys[0]?.embedSdkVersion, SIGN_IN);
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

/** A room module as a template game writes one, sharing a constant with its client in `src/`. */
const ROOM_MODULE = [
  'import { SPEED } from "../src/world.js";',
  "export default {",
  "  contract: 1,",
  '  config: { tickHz: 30, maxPlayers: 4, preset: { name: "topdown" } },',
  "  init: () => ({ joins: 0 }),",
  '  onJoin(ctx, player) { ctx.state.joins += SPEED > 0 ? 1 : 0; ctx.entities.spawn({ kind: "player", owner: player.id, hp: 3 }); },',
  "  onLeave(ctx, player) { const me = ctx.entities.ownedBy(player.id); if (me) ctx.entities.remove(me.id); },",
  "  onInput() {},",
  "  step() {},",
  "};",
].join("\n");

/** A room module the gate refuses: every tick throws. */
const BROKEN_ROOM_MODULE = [
  "export default {",
  "  contract: 1,",
  '  config: { tickHz: 30, maxPlayers: 4, preset: { name: "topdown" } },',
  "  init: () => ({}),",
  "  onJoin() {},",
  "  onLeave() {},",
  "  onInput() {},",
  '  step() { throw new Error("broken room"); },',
  "};",
].join("\n");

describe("a server-authoritative game publishes its room module", () => {
  const room = { module: "server/room.js", tickHz: 30, maxPlayers: 4 };

  /** The host's `export.stage` for the fixture's game: its public page, and its room staged beside it. */
  const stageWithRoom = (fx: { game: string; workspace: string }, manifest: GenexGameManifest) => async () => {
    const dist = path.join(fx.workspace, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.html"), BARE_PAGE);
    const module = roomModulePath(manifest.genex?.authority);
    if (module) await stageRoom(fx.game, fx.workspace, module);
    else await clearStagedRoom(fx.workspace);
    return { dir: dist, files: 1, included: ["index.html"], excluded: [], genex: manifest };
  };

  it("bundles, validates and stores the module with Studio's toolchain, and the go-live names it", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      await mkdir(path.join(fx.game, "server"), { recursive: true });
      await mkdir(path.join(fx.game, "src"), { recursive: true });
      await writeFile(path.join(fx.game, "server", "room.js"), ROOM_MODULE);
      await writeFile(path.join(fx.game, "src", "world.js"), "export const SPEED = 4;");
      const manifest: GenexGameManifest = { dependencies: {}, genex: { authority: room } };
      const started = await fx.genex.publishGallery(PROJECT, stageWithRoom(fx, manifest), "Arena");
      const done = await fx.genex.publishWait(PROJECT, started.job?.id);
      assert.equal(done.job?.state, "done", done.job?.error);
      const goLive = fx.seen.deploys[0]?.authority as { moduleSha256?: string; tickHz?: number } | undefined;
      assert.ok(goLive?.moduleSha256, "the go-live names the room module");
      assert.equal(goLive.tickHz, 30);
      assert.match(
        fx.seen.modules.get(goLive.moduleSha256) ?? "",
        /SPEED/,
        "the stored module carries its shared file",
      );
      assert.ok(
        [...fx.hosted.keys()].every((file) => !file.toLowerCase().startsWith("server/")),
        "no server file is served at the game's address",
      );
      assert.deepEqual(
        done.job?.room,
        { module: room.module, validated: true, uploaded: true, moduleSha256: goLive.moduleSha256 },
        "the publish says the room module passed the gate and went up with this build",
      );
    } finally {
      await fx.close();
    }
  });

  it("says a room module that fails the gate was neither validated nor uploaded, with the gate's reasons", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      await mkdir(path.join(fx.game, "server"), { recursive: true });
      await writeFile(path.join(fx.game, "server", "room.js"), BROKEN_ROOM_MODULE);
      const manifest: GenexGameManifest = { dependencies: {}, genex: { authority: room } };
      const started = await fx.genex.publishDraft(PROJECT, stageWithRoom(fx, manifest));
      const done = await fx.genex.publishWait(PROJECT, started.job?.id);
      assert.equal(done.job?.state, "failed");
      assert.equal(done.job?.room?.module, room.module);
      assert.equal(done.job?.room?.validated, false);
      assert.equal(done.job?.room?.uploaded, false);
      assert.ok(done.job?.room?.failures?.length, "the gate's typed reasons ride along");
      assert.equal(fx.seen.modules.size, 0, "nothing was stored");
    } finally {
      await fx.close();
    }
  });

  it("publishes a game with no room exactly as before: no module, no toolchain, no staged room", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      await mkdir(path.join(fx.game, "server"), { recursive: true });
      await writeFile(path.join(fx.game, "server", "room.js"), ROOM_MODULE);
      const withRoom: GenexGameManifest = { dependencies: {}, genex: { authority: room } };
      await mkdir(path.join(fx.game, "src"), { recursive: true });
      await writeFile(path.join(fx.game, "src", "world.js"), "export const SPEED = 4;");
      await fx.genex.publishWait(PROJECT, (await fx.genex.publishDraft(PROJECT, stageWithRoom(fx, withRoom))).job?.id);
      const plain = await fx.genex.publishWait(
        PROJECT,
        (await fx.genex.publishDraft(PROJECT, stageWithRoom(fx, SIGN_IN_GAME))).job?.id,
      );
      assert.equal(plain.job?.state, "done", plain.job?.error);
      assert.equal(plain.job?.room, undefined, "a publish with no room says nothing of one");
      assert.equal(
        Object.hasOwn(fx.seen.deploys.at(-1) ?? {}, "authority"),
        false,
        "the deploy body is the one it always was",
      );
      const copy = (await readdir(fx.workspace)).filter((name) => ["node_modules", "server", "src"].includes(name));
      assert.deepEqual(copy, [], "the earlier room and its toolchain are gone from the copy");
      assert.deepEqual(JSON.parse(await readFile(path.join(fx.workspace, "package.json"), "utf8")).genex, undefined);
    } finally {
      await fx.close();
    }
  });
});

describe("an Unreal game's room module goes with its apps", () => {
  const room = { module: "server/room.ts", tickHz: 30, maxPlayers: 4 };
  /** A room module in TypeScript, as the Unreal multiplayer skill has the builder write one. */
  const ROOM_TS = ROOM_MODULE.replace('"../src/world.js"', '"./rules.ts"').replace(
    "onJoin(ctx, player)",
    "onJoin(ctx: any, player: { id: string })",
  );
  /** A 64-bit arm64 Mach-O executable's first bytes. */
  const machO = () => {
    const head = Buffer.alloc(32);
    head.writeUInt32LE(0xfeedfacf, 0);
    head.writeUInt32LE(0x0100000c, 4);
    return head;
  };
  const PLIST = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    "<key>CFBundleExecutable</key><string>Duel</string>",
    "<key>CFBundleShortVersionString</key><string>1.0</string>",
    "</dict></plist>",
  ].join("");

  /**
   * The Unreal game Genex's New game makes, with Genex's multiplayer plugin, its room in `server/`,
   * the block in `genex.json` (`authority` null leaves it out) and a packaged Mac app.
   */
  async function unrealGame(game: string, module: string, authority: unknown = room): Promise<string> {
    const files: Record<string, string | Buffer> = {
      "studio.json": "{}",
      "unreal/Duel.uproject": JSON.stringify({
        FileVersion: 3,
        Plugins: [{ Name: "GenexMultiplayer", Enabled: true }],
      }),
      "unreal/Plugins/GenexMultiplayer/GenexMultiplayer.uplugin": JSON.stringify({ FileVersion: 3 }),
      "server/room.ts": module,
      "server/rules.ts": "export const SPEED = 4;",
      "genex.json": JSON.stringify(authority === null ? {} : { authority }),
      "Builds/Mac/Duel.app/Contents/Info.plist": PLIST,
      "Builds/Mac/Duel.app/Contents/MacOS/Duel": machO(),
    };
    for (const [rel, data] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(game, rel)), { recursive: true });
      await writeFile(path.join(game, rel), data);
    }
    return path.join(game, "Builds", "Mac", "Duel.app");
  }

  /** The stage strip's Publish with the Mac app: the host's own `export.room`, no stand-in for it. */
  async function publishApps(fx: Awaited<ReturnType<typeof genexFixture>>, app: string) {
    const services = new PluginServices(
      path.join(fx.game, "..", "plugins"),
      { genex: fx.genex.root },
      async () => null,
    );
    const binding = { project: PROJECT, directory: fx.game };
    const roomStage = () => services.call("genex", PluginService.ExportRoom, {}, binding);
    const started = await fx.genex.publishAppsOnly(PROJECT, [{ target: app, platform: "mac" }], "Duel", {}, roomStage);
    return fx.genex.publishWait(PROJECT, started.job?.id);
  }

  it("bundles, validates and releases the room to the rooms its app joins before the app goes", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      const done = await publishApps(fx, await unrealGame(fx.game, ROOM_TS));
      assert.equal(done.job?.state, "done", done.job?.error);
      const release = fx.seen.releases[0] as {
        channel?: string;
        authority?: { moduleSha256?: string; tickHz?: number };
      };
      assert.equal(release?.channel, "production", "installed apps join the live rooms");
      const sha = release.authority?.moduleSha256;
      assert.ok(sha, "the release names the module");
      assert.equal(release.authority?.tickHz, 30);
      assert.match(fx.seen.modules.get(sha) ?? "", /SPEED/, "the stored module carries its shared file");
      assert.deepEqual(
        fx.seen.apps.map((app) => app.platform),
        ["mac"],
      );
      assert.ok(
        fx.seen.events.indexOf("release") < fx.seen.events.indexOf("app"),
        "the room is live before any player can install the app",
      );
      assert.deepEqual(
        done.job?.room,
        { module: room.module, validated: true, uploaded: true, moduleSha256: sha },
        "the publish says the room module passed the gate and went up",
      );
      assert.equal(await readdir(path.join(fx.workspace, "unreal")).catch(() => null), null, "the project stays out");
    } finally {
      await fx.close();
    }
  });

  it("fails the publish on a room module the gate refuses, and sends no app", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      const done = await publishApps(fx, await unrealGame(fx.game, BROKEN_ROOM_MODULE));
      assert.equal(done.job?.state, "failed");
      assert.equal(done.job?.room?.module, room.module);
      assert.equal(done.job?.room?.validated, false);
      assert.equal(done.job?.room?.uploaded, false);
      assert.ok(done.job?.room?.failures?.length, "the gate's typed reasons ride along");
      assert.equal(fx.seen.modules.size, 0, "nothing was stored");
      assert.deepEqual(fx.seen.releases, []);
      assert.deepEqual(fx.seen.apps, [], "an app whose room would refuse every join never goes");
    } finally {
      await fx.close();
    }
  });

  it("publishes the apps of a game with no room block exactly as before", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await genexFixture();
    try {
      const done = await publishApps(fx, await unrealGame(fx.game, ROOM_TS, null));
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal(done.job?.room, undefined, "a publish with no room says nothing of one");
      assert.deepEqual(fx.seen.releases, []);
      assert.equal(fx.seen.modules.size, 0);
      assert.deepEqual(
        fx.seen.apps.map((app) => app.platform),
        ["mac"],
      );
      const copy = (await readdir(fx.workspace)).filter((name) =>
        ["node_modules", "server", "package.json"].includes(name),
      );
      assert.deepEqual(copy, [], "no room, toolchain or manifest in the copy");
    } finally {
      await fx.close();
    }
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
        { devDependencies: { "@genex-ai/multiplayer": "^0.17.0" } },
        { dependencies: { "@genex-ai/multiplayer": "^0.17.0" } },
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

  it("tells Genex the multiplayer a template game's import map takes from Studio, at Studio's pin, with its genex.json settings", async () => {
    const root = await tmpDir("studio-genex-manifest-");
    const game = path.join(root, "template");
    await mkdir(game);
    const page = (imports: Record<string, string>) =>
      `<script type="importmap">${JSON.stringify({ imports: { three: "/vendor/three.module.js", ...imports } })}</script>`;
    const multiplayer = { "@genex-ai/multiplayer": GENEX_GAME_PACKAGES["@genex-ai/multiplayer"] };
    await writeFile(path.join(game, "index.html"), page({}));
    assert.equal(await readGenexGameManifest(game), undefined, "a template game that turns nothing on");
    // Player identity alone is Studio's to name: it connects the game and names the SDK it ships.
    await writeFile(path.join(game, "index.html"), page(studioSdkImports("@genex-ai/embed-sdk")));
    assert.equal(await readGenexGameManifest(game), undefined, "Studio's own sign-in");
    await writeFile(path.join(game, "index.html"), page(studioSdkImports("@genex-ai/multiplayer")));
    assert.deepEqual(await readGenexGameManifest(game), { dependencies: multiplayer });
    await writeFile(path.join(game, "genex.json"), JSON.stringify({ matchmaking: { preset: "duel" } }));
    assert.deepEqual(await readGenexGameManifest(game), {
      dependencies: multiplayer,
      genex: { matchmaking: { preset: "duel" } },
    });
    // A Genex name mapped anywhere but Studio's copy is not Studio's to vouch for.
    await writeFile(
      path.join(game, "index.html"),
      page({ "@genex-ai/multiplayer": "https://esm.sh/@genex-ai/multiplayer" }),
    );
    await writeFile(path.join(game, "genex.json"), "{ not json");
    assert.equal(await readGenexGameManifest(game), undefined, "a CDN copy and unparsable settings");
    // A package.json is the game's own say, even when it names nothing.
    await writeFile(path.join(game, "index.html"), page(studioSdkImports("@genex-ai/multiplayer")));
    await writeFile(path.join(game, "package.json"), "{}");
    assert.equal(await readGenexGameManifest(game), undefined, "a package.json wins over the page");
    await rm(path.join(game, "package.json"));
    const outside = path.join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ mobileControls: true }));
    await rm(path.join(game, "genex.json"));
    await symlink(outside, path.join(game, "genex.json"));
    assert.deepEqual(
      await readGenexGameManifest(game),
      { dependencies: multiplayer },
      "settings linked in from outside the game are not read",
    );
  });

  it("tells Genex the multiplayer a Godot game's project carries, at Studio's pin, with its genex.json settings", async () => {
    const root = await tmpDir("studio-genex-godot-manifest-");
    const game = path.join(root, "godot-game");
    const addon = path.join(game, "godot/addons/genex_multiplayer");
    await mkdir(path.join(game, "godot"), { recursive: true });
    await writeFile(path.join(game, "godot/project.godot"), "config_version=5\n");
    assert.equal(await readGenexGameManifest(game), undefined, "a single-player Godot game");
    await mkdir(addon, { recursive: true });
    await writeFile(path.join(addon, "plugin.cfg"), '[plugin]\nname="Genex Multiplayer"\n');
    const multiplayer = { "@genex-ai/multiplayer": GENEX_GAME_PACKAGES["@genex-ai/multiplayer"] };
    assert.deepEqual(await readGenexGameManifest(game), { dependencies: multiplayer });
    await writeFile(path.join(game, "genex.json"), JSON.stringify({ matchmaking: { preset: "open" } }));
    assert.deepEqual(await readGenexGameManifest(game), {
      dependencies: multiplayer,
      genex: { matchmaking: { preset: "open" } },
    });
    assert.equal(await usesGenexMultiplayer(game), true);
    // An addon linked in from outside the game is not the game's to vouch for.
    const linked = path.join(root, "linked-game");
    await mkdir(path.join(linked, "godot/addons"), { recursive: true });
    await symlink(addon, path.join(linked, "godot/addons/genex_multiplayer"));
    assert.equal(await readGenexGameManifest(linked), undefined, "a linked addon");
  });

  it("tells Genex the multiplayer a Unity game's project embeds, at its root or in unity/, with its genex.json", async () => {
    const root = await tmpDir("studio-genex-unity-manifest-");
    const multiplayer = { "@genex-ai/multiplayer": GENEX_GAME_PACKAGES["@genex-ai/multiplayer"] };
    for (const place of [".", "unity"]) {
      const game = path.join(root, `game-${place === "." ? "root" : place}`);
      const project = path.join(game, place);
      await mkdir(path.join(project, "ProjectSettings"), { recursive: true });
      assert.equal(await readGenexGameManifest(game), undefined, `${place}: a single-player Unity game`);
      const pkg = path.join(project, "Packages/com.genex.multiplayer");
      await mkdir(pkg, { recursive: true });
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "com.genex.multiplayer" }));
      assert.deepEqual(await readGenexGameManifest(game), { dependencies: multiplayer }, place);
      await writeFile(path.join(game, "genex.json"), JSON.stringify({ matchmaking: { preset: "duel" } }));
      assert.deepEqual(
        await readGenexGameManifest(game),
        { dependencies: multiplayer, genex: { matchmaking: { preset: "duel" } } },
        place,
      );
    }
  });

  it("connects a template game that maps Studio's multiplayer, and leaves a game with its own SDK alone", () => {
    assert.equal(bringsOwnSdk({ dependencies: { "@genex-ai/multiplayer": "0.17.0" } }), false);
    assert.equal(bringsOwnSdk({ dependencies: { "@genex-ai/embed-sdk": "0.30.0" } }), true);
    assert.equal(bringsOwnSdk(undefined), false);
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
