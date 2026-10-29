/**
 * Remixing a game published from Studio. Studio runs the Genex CLI in its own publish workspace, so a
 * game's source on Genex used to be Studio's bookkeeping, and a remix of a game with only apps got an
 * empty repository. Now the person chooses Allow remixing with each publish: allowed, Studio stages
 * the game's project and the upload pushes that folder (`--source`), and Genex opens the game to
 * remixers; not allowed, or when the project could not go, remixing is turned off on Genex. A game
 * with only apps sends its project with `genex make-remixable --source` once its apps are live.
 *
 * The web publish runs the real pinned CLI against a fixture Genex on 127.0.0.1, with a preload that
 * records what Studio asked and takes `--source` off before the CLI reads it; the apps publish runs a
 * stand-in for the CLI. Nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { hasSourceOption, readRemixSaved } from "../../src/plugins/genex/remix-publish.ts";
import { GenexRemixProblem } from "../../src/shared/genex.ts";
import { startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "racing-demo";
const SLUG = "racing-demo";
/** A test window short enough for the draft test to settle at once. */
const QUICK_TEST_MS = 50;
const PAGE = '<!doctype html><meta charset="utf-8"><title>Racing</title>';
/** Studio's own preload, which hands the CLI its sign-in: the recording preload runs it after itself. */
const STUDIO_PRELOAD = pathToFileURL(path.resolve("src/genex-host/preload.mjs")).href;

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
  const shim = await tmpDir("studio-genex-remix-bin-");
  await writeFile(path.join(shim, "git-lfs"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PATH = `${shim}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  process.env.PATH = originalPath;
});

describe("which CLI sends a game's project", () => {
  it("is release 1.36.13 or newer; a prerelease of 1.36.13 may predate `--source`", () => {
    for (const version of ["1.36.13", "1.36.14-dev.1", "1.37.0", "2.0.0"])
      assert.equal(hasSourceOption(version), true, version);
    for (const version of ["1.36.12", "1.36.11", "1.36.13-dev.4", "1.35.99", "", "latest", "1.36"])
      assert.equal(hasSourceOption(version), false, version);
  });
});

describe("remix.json as read", () => {
  it("keeps only a well-formed record: anything else is no choice at all", () => {
    assert.deepEqual(readRemixSaved({ allowed: true, sentAt: "2026-10-22T10:00:00.000Z", files: 3, bytes: 99 }), {
      allowed: true,
      sentAt: "2026-10-22T10:00:00.000Z",
      files: 3,
      bytes: 99,
    });
    const hostile: unknown[] = [
      null,
      "allowed",
      [],
      { allowed: "yes" },
      { sentAt: "not a date" },
      { files: -1, bytes: 1.5 },
      { problem: "made-up" },
      { problem: GenexRemixProblem.TooBig, files: Number.NaN },
    ];
    for (const value of hostile) {
      const read = readRemixSaved(value);
      assert.equal(read.allowed, undefined, JSON.stringify(value));
      assert.equal(read.sentAt, undefined, JSON.stringify(value));
      assert.equal(read.files, undefined, JSON.stringify(value));
    }
    assert.deepEqual(readRemixSaved({ problem: GenexRemixProblem.TooBig }), { problem: GenexRemixProblem.TooBig });
  });
});

/** What the CLI was asked to run, as the preload saw it, with the files of a `--source` folder. */
interface CliRun {
  args: string[];
  cwd: string;
  sourceFiles?: string[];
}

/**
 * A fixture Genex for one game and Studio's tools on the real pinned CLI. The preload records each
 * run's arguments and the files of the folder `--source` names, then takes the option off: the
 * pinned CLI predates it, and what it pushes is the CLI's own concern.
 */
async function remixFixture(options: { sendsSource?: boolean; gameRepo?: boolean } = {}) {
  const temp = await realpath(await tmpDir("studio-genex-remix-"));
  const bare = path.join(temp, "source.git");
  await mkdir(bare, { recursive: true });
  assert.ok(await run("git", ["init", "--bare", "-q", bare]));
  const pushUrl = pathToFileURL(bare).href;
  const visibility: Array<{ private: unknown }> = [];
  const hosted = new Map<string, string>();
  let status = "draft",
    stagingCommitSha = "",
    api = "";
  const server = await startGenexFixtureApi(({ method, url, body }, reply) => {
    if (url.startsWith("/upload/") && method === "PUT") {
      hosted.set(decodeURIComponent(url.slice("/upload/".length)), body);
      return reply.json({ ok: true });
    }
    if (url.startsWith("/live/")) {
      const served = hosted.get(decodeURIComponent(url.slice("/live/".length).split("?")[0] ?? ""));
      return reply.text(served ?? "missing", served === undefined ? 404 : 200);
    }
    if (url === "/api/projects" && method === "POST")
      return reply.json({ project: { id: "p1", slug: SLUG, cloneUrl: pushUrl, playUrl: `${api}/live` } });
    if (url === `/api/projects/by-slug/${SLUG}`)
      return reply.json({ project: { slug: SLUG, status, stagingCommitSha } });
    if (url === "/api/projects/p1/push-token" && method === "POST") return reply.json({ pushUrl, managed: true });
    if (url === "/api/projects/p1/visibility" && method === "PATCH") {
      visibility.push(JSON.parse(body || "{}"));
      return reply.json({ ok: true });
    }
    if (url === "/api/projects/p1/publish" && method === "POST") {
      status = "published";
      return reply.json({ ok: true });
    }
    if (url === "/api/games/p1/upload-token" && method === "POST")
      return reply.json({
        token: "fixture-upload-token",
        uploadUrl: `${api}/upload`,
        playUrl: `${api}/live`,
        channels: ["staging", "production"],
        limits: { maxFiles: 1000, maxFileBytes: 100_000_000, maxTotalBytes: 1_000_000_000 },
      });
    if (url === "/api/games/p1/publish" && method === "POST") {
      stagingCommitSha = JSON.parse(body || "{}").commit;
      return reply.json({ url: `${api}/live`, channel: "staging" });
    }
    if (url === "/api/games/p1/promote" && method === "POST")
      return reply.json({ commit: stagingCommitSha, url: `${api}/live` });
    if (url.startsWith("/api/gallery/world/")) return reply.json({ item: null });
  });
  api = server.url;
  const log = path.join(temp, "cli-runs.jsonl");
  const preload = path.join(temp, "record-source.mjs");
  await writeFile(
    preload,
    `import { appendFileSync, readdirSync } from "node:fs";
const args = process.argv.slice(2);
const at = process.argv.indexOf("--source");
const entry = { args, cwd: process.cwd() };
if (at >= 0) {
  entry.sourceFiles = readdirSync(process.argv[at + 1], { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => [item.parentPath.slice(process.argv[at + 1].length + 1), item.name].filter(Boolean).join("/"))
    .sort();
  process.argv.splice(at, 2);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
await import(${JSON.stringify(STUDIO_PRELOAD)});
`,
  );
  const game = path.join(temp, "game");
  await mkdir(path.join(game, "src"), { recursive: true });
  await writeFile(path.join(game, "studio.json"), '{"name":"racing-demo"}');
  await writeFile(path.join(game, "index.html"), PAGE);
  await writeFile(path.join(game, "src", "main.js"), "start()");
  await writeFile(path.join(game, ".env"), "SECRET=1");
  if (options.gameRepo !== false) execFileSync("git", ["init", "-q"], { cwd: game });
  const genex = new GenexTools(path.join(temp, "host"), api, {
    credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
    draftTestMs: QUICK_TEST_MS,
    preload,
    sendsSource: options.sendsSource ?? true,
  });
  const workspace = path.join(genex.root, "publish", PROJECT);
  const exportStage = async () => {
    const dist = path.join(workspace, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.html"), PAGE);
    return { dir: dist, files: 1, included: ["index.html"], excluded: [] };
  };
  /** Publish the game with Allow remixing `remix` (undefined: no one chose, as an agent's publish). */
  const publish = async (remix?: boolean) => {
    const choice = { gameDir: game, ...(remix === undefined ? {} : { allowed: remix }) };
    const started = await genex.publishGallery(PROJECT, exportStage, "Racing Demo", undefined, [], choice);
    return genex.publishWait(PROJECT, started.job?.id);
  };
  /** Put the game on its draft page only, as an agent's draft does: no one chose about remixing. */
  const draft = async () => {
    const started = await genex.publishDraft(PROJECT, exportStage);
    return genex.publishWait(PROJECT, started.job?.id);
  };
  const runs = async (): Promise<CliRun[]> =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CliRun);
  const uploads = async () => (await runs()).filter((entry) => entry.args[0] === "preview");
  return { genex, workspace, game, publish, draft, uploads, visibility, close: () => server.close() };
}

describe("a publish with Allow remixing", () => {
  it("pushes the game's own project as its source and opens the game to remixers", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await remixFixture();
    try {
      const done = await fx.publish(true);
      assert.equal(done.job?.state, "done", done.job?.error);
      const [upload] = await fx.uploads();
      const at = upload?.args.indexOf("--source") ?? -1;
      assert.deepEqual(upload?.args.slice(at, at + 2), ["--source", path.join(fx.workspace, "source")]);
      assert.deepEqual(
        upload?.sourceFiles,
        ["index.html", "src/main.js", "studio.json"],
        "the game, without its secrets",
      );
      assert.deepEqual(fx.visibility, [{ private: false }]);
      assert.equal(done.remix?.supported, true);
      assert.equal(done.remix?.allowed, true);
      assert.equal(done.remix?.files, 3);
      assert.ok(done.remix?.sentAt, "the record says when the project went");
    } finally {
      await fx.close();
    }
  });

  it("sends no project and turns remixing off when the person does not allow it", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await remixFixture();
    try {
      const done = await fx.publish(false);
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal((await fx.uploads())[0]?.args.includes("--source"), false);
      assert.deepEqual(fx.visibility, [{ private: true }]);
      assert.deepEqual(
        { allowed: done.remix?.allowed, sentAt: done.remix?.sentAt },
        { allowed: false, sentAt: undefined },
      );
    } finally {
      await fx.close();
    }
  });

  it("publishes but keeps remixing off, saying why, when the project cannot go", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await remixFixture({ gameRepo: false });
    try {
      const done = await fx.publish(true);
      assert.equal(done.job?.state, "done", "the game still goes live");
      assert.equal((await fx.uploads())[0]?.args.includes("--source"), false);
      assert.deepEqual(fx.visibility, [{ private: true }]);
      assert.equal(done.remix?.problem, GenexRemixProblem.NoRepository);
      assert.equal(done.remix?.sentAt, undefined);
    } finally {
      await fx.close();
    }
  });

  it("follows the person's last choice when a publish makes none, and allows nothing before any", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await remixFixture();
    try {
      await fx.publish();
      assert.equal((await fx.uploads())[0]?.args.includes("--source"), false, "no one chose: nothing goes");
      await fx.publish(true);
      await fx.publish();
      const uploads = await fx.uploads();
      assert.equal(uploads.length, 3);
      assert.ok(uploads.slice(1).every((upload) => upload.args.includes("--source")));
      assert.deepEqual(fx.visibility, [{ private: true }, { private: false }, { private: false }]);
    } finally {
      await fx.close();
    }
  });

  it("never leaves the project in the workspace, so a later push of the workspace can't carry it", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await remixFixture();
    try {
      await fx.publish(true);
      assert.equal(await stat(path.join(fx.workspace, "source")).catch(() => null), null, "the staged copy is gone");
      const ignored = (await readFile(path.join(fx.workspace, ".gitignore"), "utf8")).split("\n");
      for (const rule of ["home/", "source/", "remix.json"])
        assert.ok(ignored.includes(rule), `the workspace ignores ${rule}`);
      const draft = await fx.draft();
      assert.equal(draft.job?.state, "done", draft.job?.error);
      assert.equal((await fx.uploads()).at(-1)?.args.includes("--source"), false, "a draft carries no project");
      assert.deepEqual(fx.visibility, [{ private: false }], "and changes nothing on Genex");
    } finally {
      await fx.close();
    }
  });

  it("changes nothing on Genex while the CLI cannot send a project", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await remixFixture({ sendsSource: false });
    try {
      const done = await fx.publish(true);
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal((await fx.uploads())[0]?.args.includes("--source"), false);
      assert.deepEqual(fx.visibility, []);
      assert.deepEqual(done.remix, { supported: false, sending: false });
    } finally {
      await fx.close();
    }
  });
});

/**
 * Studio's tools on a stand-in for the CLI for a game with only apps: `init` makes the hosted
 * project, `native publish` lists the game, and `make-remixable` records the folder it was told to
 * send (failing when `fail` says so).
 */
async function appsFixture(options: { failRemixable?: boolean } = {}) {
  const temp = await realpath(await tmpDir("studio-genex-remix-apps-"));
  const log = path.join(temp, "runs.jsonl");
  const visibility: Array<{ private: unknown }> = [];
  const server = await startGenexFixtureApi(({ method, url, body }, reply) => {
    if (url === "/api/projects/p1/visibility" && method === "PATCH") {
      visibility.push(JSON.parse(body || "{}"));
      return reply.json({ ok: true });
    }
  });
  const standIn = path.join(temp, "apps-cli.mjs");
  await writeFile(
    standIn,
    `import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = args.indexOf("--source");
const sourceFiles = at >= 0 ? readdirSync(args[at + 1]).sort() : undefined;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), sourceFiles }) + "\\n");
if (args[0] === "init") {
  mkdirSync(".genex", { recursive: true });
  writeFileSync(".genex/project.json", JSON.stringify({ slug: "megastructure", id: "p1", status: "draft" }));
  process.exit(0);
}
if (args[0] === "cover") { process.stdout.write(JSON.stringify({ coverUrl: null, coverSource: null })); process.exit(0); }
if (args[0] === "make-remixable") process.exit(${options.failRemixable ? 1 : 0});
const build = { platform: "mac", arch: "arm64", version: "1.0+abc", sizeBytes: 10, sha256: "${"a".repeat(64)}", publishedAt: "2026-10-22T08:00:00.000Z" };
process.stdout.write(JSON.stringify({ build, engine: "unity", listing: { state: "published", slug: "megastructure" } }));
process.exit(0);
`,
  );
  const game = path.join(temp, "game");
  await mkdir(path.join(game, "unity", "Assets"), { recursive: true });
  await mkdir(path.join(game, "unity", "ProjectSettings"), { recursive: true });
  await mkdir(path.join(game, "unity", "Library"), { recursive: true });
  await writeFile(path.join(game, "studio.json"), '{"name":"megastructure"}');
  await writeFile(path.join(game, "unity", "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.2");
  await writeFile(path.join(game, "unity", "Assets", "Main.unity"), "scene");
  await writeFile(path.join(game, "unity", "Library", "ArtifactDB"), "cache");
  execFileSync("git", ["init", "-q"], { cwd: game });
  const genex = new GenexTools(path.join(temp, "host"), server.url, {
    credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
    preload: standIn,
    sendsApps: true,
    sendsSource: true,
  });
  const runs = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CliRun);
  const app = { target: path.join(game, "unity", "Builds", "Mac", "Megastructure.app"), platform: "mac" as const };
  const publish = async (remix: boolean) => {
    const started = await genex.publishAppsOnly(PROJECT, [app], "Megastructure", undefined, {
      allowed: remix,
      gameDir: game,
    });
    return genex.publishWait(PROJECT, started.job?.id);
  };
  return { genex, game, runs, publish, visibility, close: () => server.close() };
}

describe("a game with only apps, published with Allow remixing", () => {
  it("sends its project with `make-remixable --source` once its apps are live, without the engine's caches", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; staging reads the game's git");
    const fx = await appsFixture();
    try {
      const done = await fx.publish(true);
      assert.equal(done.job?.state, "done", done.job?.error);
      const remixable = (await fx.runs()).filter((entry) => entry.args[0] === "make-remixable");
      assert.equal(remixable.length, 1);
      assert.deepEqual(remixable[0]?.sourceFiles, ["studio.json", "unity"]);
      assert.equal(remixable[0]?.args.includes(path.join(fx.genex.root, "publish", PROJECT, "source")), true);
      assert.ok(done.remix?.sentAt);
      assert.equal(done.remix?.files, 3, "studio.json, the scene and ProjectVersion.txt: no Library");
      assert.deepEqual(fx.visibility, [], "make-remixable opens the game itself");
    } finally {
      await fx.close();
    }
  });

  it("turns remixing off instead when it is not allowed, or when the project did not go", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; staging reads the game's git");
    const off = await appsFixture();
    const failing = await appsFixture({ failRemixable: true });
    try {
      const done = await off.publish(false);
      assert.equal(
        (await off.runs()).some((entry) => entry.args[0] === "make-remixable"),
        false,
      );
      assert.deepEqual(off.visibility, [{ private: true }]);
      assert.equal(done.remix?.allowed, false);
      const failed = await failing.publish(true);
      assert.equal(failed.job?.state, "done", "the apps stay live");
      assert.deepEqual(failing.visibility, [{ private: true }]);
      assert.equal(failed.remix?.problem, GenexRemixProblem.Failed);
      assert.equal(failed.remix?.sentAt, undefined);
    } finally {
      await off.close();
      await failing.close();
    }
  });
});
