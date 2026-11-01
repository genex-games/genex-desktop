/**
 * A publish's apps, sent with `genex native publish` once the web build is public. Only a CLI new
 * enough to have the command sends any. The builds come from the dialog by their place in the game
 * folder, which agents write: only a real `.app`, or a Windows or Linux program's folder, inside the
 * folder is ever handed to the CLI, a Linux one with its platform and program named. One app that fails is kept as that app's failure, in the CLI's own words.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { realpath } from "node:fs/promises";
import { after } from "node:test";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { saveClip } from "../../src/plugins/genex/clip.ts";
import { saveShot } from "../../src/plugins/genex/cover.ts";
import { GENEX_COVERS_DIR } from "../../src/shared/genex.ts";
import { type GenexFixtureApi, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import {
  hasNativeCommand,
  nativePublishArgs,
  nativeUploads,
  sendNativeBuild,
  sentBuild,
} from "../../src/plugins/genex/native-publish.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { setTimeout as sleep } from "node:timers/promises";

/** A 1920x1080 PNG header: all the cover's checks read before Genex sees it. */
const cover = (() => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1920, 0);
  header.writeUInt32BE(1080, 4);
  header[8] = 8;
  header[9] = 6;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, length, Buffer.from("IHDR"), header, Buffer.alloc(4)]);
})();
/** The cover the engine game's agent kept, as genex__cover writes it into the plugin's storage. */
const keepCover = (genex: GenexTools) =>
  saveShot(
    path.join(genex.root, GENEX_COVERS_DIR, "dust"),
    {
      image: cover,
      mimeType: "image/png",
      width: 1920,
      height: 1080,
      stats: { lumaMean: 0.45, lumaStdDev: 0.21, nearBlackFraction: 0.08, litFraction: 0.97 },
    },
    new Date().toISOString(),
  );

/** How `genex cover --clip --json` answers a clip Genex took, and one of a build it does not know. */
const CLIP_APPLIED = { kind: "applied", clipUrl: "https://cdn.genex.technology/clips/dust.mp4", clipSource: "agent" };
const CLIP_STALE = {
  kind: "failed",
  message:
    "That --commit is not a build this game ships — record the build on its preview (draft) or live (published) channel and pass that build's commit.",
};
/** The archive hash `genex native publish --json` answers for the stand-in's app. */
const ARCHIVE_SHA256 = "3f2a9c1d0e4b".padEnd(64, "7");

describe("which CLI sends apps", () => {
  it("is release 1.36.11 or newer: 1.36.10 has no `genex native`, and a dev build may predate it", () => {
    for (const version of ["1.36.11", "1.36.12", "1.36.12-dev.2", "1.37.0", "2.0.0"])
      assert.equal(hasNativeCommand(version), true, version);
    for (const version of [
      "1.36.10",
      "1.36.11-dev.4",
      "1.36.10-dev.4",
      "1.36.9",
      "1.35.40",
      "0.99.99",
      "",
      "latest",
      "1.36.11x",
    ])
      assert.equal(hasNativeCommand(version), false, version);
  });
});

describe("the CLI Studio ships", () => {
  it("sends apps from a bundle with no node_modules beside it, as the packaged app runs", async () => {
    // The packaged app keeps the CLI only inside the Genex plugin's payload, never in its own
    // node_modules: the main bundle must carry the pin's version, not look it up at run time.
    const outdir = await realpath(await tmpDir("native-pin-"));
    await esbuild.build({
      entryPoints: [path.join(import.meta.dirname, "../../src/plugins/genex/native-publish.ts")],
      outfile: path.join(outdir, "main.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const bundled = (await import(pathToFileURL(path.join(outdir, "main.mjs")).href)) as {
      pinnedCliSendsApps: () => boolean;
    };
    assert.equal(bundled.pinnedCliSendsApps(), true);
  });
});

/** A 64-bit x86 Linux program's ELF header. */
function elf(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(0x3e, 18);
  return bytes;
}

/** A game folder with a Mac app, Windows and Linux builds and things that only look like builds. */
async function gameFolder() {
  const root = await realpath(await tmpDir("native-publish-"));
  const game = path.join(root, "game");
  await mkdir(path.join(game, "Builds", "Mac", "Dust Runners.app", "Contents"), { recursive: true });
  await mkdir(path.join(game, "Builds", "Windows"), { recursive: true });
  await writeFile(path.join(game, "Builds", "Windows", "Dust.exe"), "MZ");
  await writeFile(path.join(game, "Root.exe"), "MZ");
  await mkdir(path.join(game, "Builds", "Linux", "Dust_Data"), { recursive: true });
  await writeFile(path.join(game, "Builds", "Linux", "Dust.x86_64"), elf());
  await writeFile(path.join(game, "Builds", "Linux", "Notes.x86_64"), "#!/bin/sh\necho not a program\n");
  const unreal = path.join(game, "Builds", "LinuxPackage", "Dust", "Binaries", "Linux");
  await mkdir(unreal, { recursive: true });
  await writeFile(path.join(unreal, "Dust-Linux-Shipping"), elf());
  await writeFile(path.join(game, "Root.x86_64"), elf());
  await writeFile(path.join(game, "notes.txt"), "words");
  const outside = path.join(root, "outside");
  await mkdir(path.join(outside, "Elsewhere.app"), { recursive: true });
  await symlink(path.join(outside, "Elsewhere.app"), path.join(game, "Builds", "Linked.app"));
  await mkdir(path.join(outside, "Win"), { recursive: true });
  await writeFile(path.join(outside, "Win", "Far.exe"), "MZ");
  await symlink(path.join(outside, "Win"), path.join(game, "Builds", "LinkedWin"));
  await mkdir(path.join(outside, "Tux"), { recursive: true });
  await writeFile(path.join(outside, "Tux", "Far.x86_64"), elf());
  await symlink(path.join(outside, "Tux"), path.join(game, "Builds", "LinkedLinux"));
  await symlink(path.join(outside, "Tux", "Far.x86_64"), path.join(game, "Builds", "Linux", "Linked.x86_64"));
  return { game, outside };
}

describe("the apps a publish hands the CLI", () => {
  it("takes a Mac app and a Windows program's folder from inside the game folder", async () => {
    const { game } = await gameFolder();
    const uploads = await nativeUploads(game, ["Builds/Mac/Dust Runners.app", "Builds/Windows/Dust.exe"]);
    assert.deepEqual(uploads, [
      { target: path.join(game, "Builds", "Mac", "Dust Runners.app"), platform: "mac" },
      { target: path.join(game, "Builds", "Windows"), platform: "windows" },
    ]);
  });

  it("takes a Linux program's folder with the program in it, and an Unreal package whole", async () => {
    const { game } = await gameFolder();
    const uploads = await nativeUploads(game, [
      "Builds/Linux/Dust.x86_64",
      "Builds/LinuxPackage/Dust/Binaries/Linux/Dust-Linux-Shipping",
    ]);
    assert.deepEqual(uploads, [
      { target: path.join(game, "Builds", "Linux"), platform: "linux", entry: "Dust.x86_64" },
      {
        target: path.join(game, "Builds", "LinuxPackage"),
        platform: "linux",
        entry: "Dust/Binaries/Linux/Dust-Linux-Shipping",
      },
    ]);
    assert.deepEqual(nativePublishArgs(uploads[0] ?? { target: "", platform: "mac" }), [
      "native",
      "publish",
      path.join(game, "Builds", "Linux"),
      "--platform",
      "linux",
      "--entry",
      "Dust.x86_64",
    ]);
    assert.deepEqual(nativePublishArgs({ target: "/game/Builds/Windows", platform: "windows", entry: "x" }), [
      "native",
      "publish",
      "/game/Builds/Windows",
    ]);
  });

  it("hands over nothing that is not a build inside the game folder", async () => {
    const { game, outside } = await gameFolder();
    const hostile: unknown[] = [
      path.join(outside, "Elsewhere.app"),
      "../outside/Elsewhere.app",
      "Builds/../../outside/Elsewhere.app",
      "Builds/Linked.app",
      "Builds/LinkedWin/Far.exe",
      "Builds/LinkedLinux/Far.x86_64",
      "Builds/Linux/Linked.x86_64",
      "Builds/Linux/Notes.x86_64",
      "Root.x86_64",
      "Root.exe",
      "notes.txt",
      "Builds/Missing.app",
      "Builds/Mac",
      "",
      7,
      null,
    ];
    for (const entry of hostile) assert.deepEqual(await nativeUploads(game, [entry]), [], String(entry));
    assert.deepEqual(await nativeUploads(game, "Builds/Mac/Dust Runners.app"), [], "a list, not a string");
    assert.deepEqual(await nativeUploads(path.join(game, "nowhere"), ["Builds/Mac/Dust Runners.app"]), []);
  });

  it("sends each app once, and at most six", async () => {
    const { game } = await gameFolder();
    const twice = await nativeUploads(game, ["Builds/Mac/Dust Runners.app", "Builds/Mac/./Dust Runners.app"]);
    assert.equal(twice.length, 1);
  });
});

describe("one app sent", () => {
  const MAC = { target: "/game/Builds/Mac/Dust Runners.app", platform: "mac" as const };
  const BUILD = {
    platform: "mac",
    arch: "universal",
    version: "1.0+3f2a9c1d0e4b",
    sizeBytes: 1_400_000_000,
    sha256: "a".repeat(64),
    url: "https://cdn.genex.technology/games/dust-runners/native/mac-universal/aaaa.zip",
    entry: "Dust Runners.app",
    installedBytes: 2_000_000_000,
    publishedAt: "2026-10-20T08:00:00.000Z",
  };

  it("keeps the build the CLI says it published", async () => {
    const sent: string[] = [];
    const outcome = await sendNativeBuild(MAC, async (target) => {
      sent.push(target);
      return { build: BUILD, engine: "unity" };
    });
    assert.deepEqual(sent, [MAC.target]);
    assert.deepEqual(outcome, {
      sent: {
        platform: "mac",
        arch: "universal",
        version: "1.0+3f2a9c1d0e4b",
        sizeBytes: 1_400_000_000,
        sha256: "a".repeat(64),
        publishedAt: "2026-10-20T08:00:00.000Z",
      },
    });
  });

  it("keeps Genex's review of the build: waiting, or turned down and why", async () => {
    const waiting = await sendNativeBuild(MAC, async () => ({
      build: { ...BUILD, review: "pending" },
      listing: { state: "published", slug: "dust-runners" },
    }));
    assert.equal("sent" in waiting ? waiting.sent.review : null, "pending");
    assert.deepEqual(waiting.listing, { state: "held", detail: null }, "a game Genex reviews is not listed yet");
    const approved = await sendNativeBuild(MAC, async () => ({
      build: { ...BUILD, review: "approved" },
      listing: { state: "published", slug: "dust-runners" },
    }));
    assert.deepEqual(approved.listing, { state: "published", detail: null });
    const rejected = sentBuild({ build: { ...BUILD, review: "rejected", reviewReason: "It opens a shell." } });
    assert.deepEqual([rejected?.review, rejected?.reviewReason], ["rejected", "It opens a shell."]);
    assert.equal(
      sentBuild({ build: { ...BUILD, review: "maybe" } })?.review,
      undefined,
      "an unknown review is dropped",
    );
  });

  it("keeps a failure in the CLI's own last words, and an answer without a build as a failure", async () => {
    const failed = await sendNativeBuild(MAC, async () => {
      throw new Error(
        "› Zipping…\n› Hashing the archive…\n✗ Couldn't get an upload token (HTTP 413).\n  over the limit",
      );
    });
    assert.deepEqual(failed, {
      failed: { platform: "mac", arch: "", error: "Couldn't get an upload token (HTTP 413)." },
    });
    const odd = await sendNativeBuild(MAC, async () => ({ engine: "unity" }));
    assert.ok("failed" in odd);
    assert.equal(sentBuild({ build: { ...BUILD, sizeBytes: "big" } }), null);
  });
});

/**
 * Genex's tools with a stand-in for the CLI: a preload that answers `genex init` and `genex native
 * publish` itself, as the real commands do (`--json`: one object, exit 1 for a refused listing), and
 * logs each run's arguments. An app whose path names "Broken" fails on stderr with a non-zero exit;
 * one naming "Held" or "Refused" gets that answer to its `--gallery` listing, and one naming "Review" is
 * listed with a build Genex still reviews.
 */
async function toolsWithStandIn(sendsApps = true, api = "http://127.0.0.1:9", clipAnswer: object = CLIP_APPLIED) {
  const root = await realpath(await tmpDir("genex-native-tools-"));
  const log = path.join(root, "runs.jsonl");
  const standIn = path.join(root, "native-cli.mjs");
  const answer = {
    platform: "mac",
    arch: "universal",
    version: "1.0+3f2a9c1d0e4b",
    sizeBytes: 10,
    sha256: ARCHIVE_SHA256,
    publishedAt: "2026-10-20T08:00:00.000Z",
  };
  await writeFile(
    standIn,
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME }) + "\\n");
if (args[0] === "init") {
  mkdirSync(".genex", { recursive: true });
  writeFileSync(".genex/project.json", JSON.stringify({ slug: "dust-runners", id: "p1", status: "draft" }));
  process.exit(0);
}
if (args[0] === "cover") {
  // \`genex cover --json\` says who chose the cover; \`genex cover <file> --json\` sends one.
  // \`genex cover --clip <file> --commit <sha> --json\` sends the clip.
  const sending = args[1] !== "--json";
  const clip = ${JSON.stringify(clipAnswer)};
  const still = { kind: "applied", coverUrl: "https://cdn.genex.technology/covers/dust.webp", coverSource: "agent" };
  process.stdout.write(JSON.stringify(args[1] === "--clip" ? clip : sending ? still : { coverUrl: null, coverSource: null }));
  process.exit(args[1] === "--clip" && clip.kind !== "applied" ? 1 : 0);
}
const target = args[args.indexOf("publish") + 1] ?? "";
if (target.includes("Broken")) {
  process.stderr.write("› Zipping…\\n✗ Couldn't get an upload token (HTTP 413).\\n");
  process.exit(1);
}
const windows = !target.endsWith(".app");
const listing = !args.includes("--gallery")
  ? undefined
  : target.includes("Refused")
    ? { state: "refused", category: "spam", detail: "The title reads as an ad." }
    : target.includes("Held")
      ? { state: "held", category: null, detail: null }
      : { state: "published", slug: "dust-runners" };
const system = args.includes("--platform") ? args[args.indexOf("--platform") + 1] : "windows";
const review = target.includes("Review") ? { review: "pending" } : {};
const build = { ...${JSON.stringify(answer)}, ...(windows ? { platform: system, arch: "x64" } : {}), ...review };
process.stdout.write(JSON.stringify({ build, engine: "unity", ...(listing ? { listing } : {}) }));
process.exit(listing?.state === "refused" ? 1 : 0);
`,
  );
  const genex = new GenexTools(path.join(root, "host"), api, {
    credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
    preload: standIn,
    sendsApps,
  });
  const runs = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string; home: string });
  return { genex, runs };
}

describe("a publish's apps sent through the CLI", () => {
  const MAC_APP = { target: "/game/Builds/Mac/Dust Runners.app", platform: "mac" as const };
  const BROKEN = { target: "/game/Builds/Windows Broken", platform: "windows" as const };
  const LINUX = { target: "/game/Builds/Linux", platform: "linux" as const, entry: "Dust.x86_64" };

  it("sends each app with `genex native publish` in the publish workspace and records how it went", async () => {
    const { genex, runs } = await toolsWithStandIn();
    await genex.publishApps("dust", "job-1", [MAC_APP, BROKEN, LINUX]);
    const calls = await runs();
    assert.deepEqual(
      calls.map((call) => call.args.slice(0, call.args.includes("--entry") ? 7 : 3)),
      [
        ["native", "publish", MAC_APP.target],
        ["native", "publish", BROKEN.target],
        ["native", "publish", LINUX.target, "--platform", "linux", "--entry", "Dust.x86_64"],
      ],
      "a Linux build names its platform and program: the CLI cannot tell them from the files",
    );
    assert.ok(calls.every((call) => call.args.includes("--json")));
    const workspace = path.join(genex.root, "publish", "dust");
    assert.ok(calls.every((call) => call.cwd === workspace && call.home === path.join(workspace, "home")));
    const { native } = await genex.publishView("dust");
    assert.equal(native?.supported, true);
    assert.equal(native?.sending, false);
    assert.equal(native?.jobId, "job-1");
    assert.deepEqual(
      native?.sent.map((sent) => [sent.platform, sent.version]),
      [
        ["mac", "1.0+3f2a9c1d0e4b"],
        ["linux", "1.0+3f2a9c1d0e4b"],
      ],
    );
    assert.deepEqual(native?.failed, [
      { platform: "windows", arch: "", error: "Couldn't get an upload token (HTTP 413)." },
    ]);
  });

  it("sends nothing while the CLI has no `genex native`, and says so", async () => {
    const { genex, runs } = await toolsWithStandIn(false);
    await genex.publishApps("dust", "job-1", [MAC_APP]);
    assert.deepEqual(await runs(), []);
    const { native } = await genex.publishView("dust");
    assert.deepEqual(native, { supported: false, sending: false, sent: [], failed: [] });
  });
});

const servers: GenexFixtureApi[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** A fixture Genex API: the signed-in session and accepted terms, nothing else. */
async function fixtureApi(): Promise<string> {
  const server = await startGenexFixtureApi(() => undefined);
  servers.push(server);
  return server.url;
}

describe("a game with only apps, published", () => {
  const app = (name: string) => ({ target: `/game/Builds/Mac/${name}.app`, platform: "mac" as const });
  const WINDOWS = { target: "/game/Builds/Windows", platform: "windows" as const };

  it("gets its hosted project, goes up app by app, and is listed with the first", async () => {
    const { genex, runs } = await toolsWithStandIn(true, await fixtureApi());
    const started = await genex.publishAppsOnly("dust", [app("Dust Runners"), WINDOWS], "Dust Runners");
    assert.equal(started.job?.state, "running");
    const state = await genex.publishWait("dust");
    const calls = (await runs()).map((call) =>
      call.args.filter((arg) => !arg.startsWith("--env") && arg !== "--api-url"),
    );
    assert.equal(calls[0]?.[0], "init", "the hosted project is made first");
    assert.deepEqual(calls[1]?.slice(0, 6), [
      "native",
      "publish",
      app("Dust Runners").target,
      "--gallery",
      "--title",
      "Dust Runners",
    ]);
    assert.equal(calls[2]?.includes("--gallery"), false, "listed once");
    assert.equal(state.job?.state, "done", JSON.stringify(state.job));
    assert.equal(state.status, "published");
    assert.equal(state.galleryUrl, "https://genex.games/dust-runners");
    assert.equal(state.title, "Dust Runners");
    assert.deepEqual(state.native?.listing, { state: "published", detail: null });
    assert.deepEqual(
      state.native?.sent.map((sent) => sent.platform),
      ["mac", "windows"],
    );
  });

  /** A publish workspace already linked to `meta`, as an earlier publish left it. */
  async function linkedTo(genex: GenexTools, meta: Record<string, unknown>) {
    const workspace = path.join(genex.root, "publish", "dust");
    await mkdir(path.join(workspace, ".genex"), { recursive: true });
    await writeFile(path.join(workspace, ".genex", "project.json"), JSON.stringify(meta));
    return workspace;
  }

  it("makes a new hosted project when the linked one is gone or isn't this account's, keeping the old link aside", async () => {
    const answers: Record<string, () => object> = {
      deleted: () => ({ error: "Not found" }),
      // An admin's sign-in sees someone else's game: it is still not this account's to publish to.
      "someone-elses": () => ({ project: { id: "p-other", slug: "someone-elses", owner: { id: "u-other" } } }),
      replaced: () => ({ project: { id: "p-new", slug: "replaced", owner: { id: "u-me" } } }),
    };
    const server = await startGenexFixtureApi((req, reply) => {
      if (req.url === "/api/auth/get-session") return reply.json({ user: { id: "u-me", email: "me@example.invalid" } });
      const slug = /^\/api\/projects\/by-slug\/([^/?]+)/.exec(req.url)?.[1] ?? "";
      const answer = answers[slug];
      if (answer) return reply.json(answer(), slug === "deleted" ? 404 : 200);
    });
    servers.push(server);
    for (const [slug, id] of [
      ["deleted", "p-old"],
      ["someone-elses", "p-other"],
      ["replaced", "p-old"],
    ]) {
      const { genex, runs } = await toolsWithStandIn(true, server.url);
      const workspace = await linkedTo(genex, { slug, id, status: "published" });
      await genex.publishAppsOnly("dust", [app("Dust Runners")], "Dust Runners");
      const state = await genex.publishWait("dust");
      assert.equal((await runs())[0]?.args[0], "init", `${slug}: a new hosted project is made first`);
      assert.equal(state.job?.state, "done", `${slug}: ${JSON.stringify(state.job)}`);
      assert.equal(state.slug, "dust-runners", slug);
      const aside = (await readdir(path.join(workspace, ".genex"))).filter((name) =>
        name.startsWith("project.unlinked-"),
      );
      assert.equal(aside.length, 1, `${slug}: the old link is kept aside, not deleted`);
    }
  });

  it("keeps publishing to its hosted project while Genex says it is this account's, or can't be asked", async () => {
    const server = await startGenexFixtureApi((req, reply) => {
      if (req.url === "/api/auth/get-session") return reply.json({ user: { id: "u-me", email: "me@example.invalid" } });
      if (req.url.startsWith("/api/projects/by-slug/mine"))
        return reply.json({ project: { id: "p1", slug: "mine", status: "published", owner: { id: "u-me" } } });
      if (req.url.startsWith("/api/projects/by-slug/flaky")) return reply.json({ error: "down" }, 503);
    });
    servers.push(server);
    for (const slug of ["mine", "flaky"]) {
      const { genex, runs } = await toolsWithStandIn(true, server.url);
      await linkedTo(genex, { slug, id: "p1", status: "published" });
      await genex.publishAppsOnly("dust", [app("Dust Runners")], "Dust Runners");
      await genex.publishWait("dust");
      assert.equal(
        (await runs()).some((call) => call.args[0] === "init"),
        false,
        `${slug}: no new hosted project`,
      );
    }
  });

  it("keeps its link while the sign-in no longer holds, though Genex then reads every game as unknown", async () => {
    const server = await startGenexFixtureApi((req, reply) => {
      if (req.url === "/api/auth/get-session") return reply.json({ user: null });
    });
    servers.push(server);
    const { genex, runs } = await toolsWithStandIn(true, server.url);
    const workspace = await linkedTo(genex, { slug: "mine", id: "p1", status: "published" });
    await genex.publishAppsOnly("dust", [app("Dust Runners")], "Dust Runners").catch(() => null);
    await genex.publishWait("dust");
    assert.equal(
      (await runs()).some((call) => call.args[0] === "init"),
      false,
      "no new hosted project",
    );
    assert.deepEqual(await readdir(path.join(workspace, ".genex")), ["project.json"], "the link stays");
  });

  it("puts back its own game set aside under another sign-in, instead of making a third", async () => {
    const server = await startGenexFixtureApi((req, reply) => {
      if (req.url === "/api/auth/get-session") return reply.json({ user: { id: "u-me", email: "me@example.invalid" } });
      if (req.url.startsWith("/api/projects/by-slug/mine"))
        return reply.json({ project: { id: "p1", slug: "mine", owner: { id: "u-me" } } });
    });
    servers.push(server);
    const { genex, runs } = await toolsWithStandIn(true, server.url);
    // The other sign-in's game is linked now; this account's own was set aside when it was made.
    const workspace = await linkedTo(genex, { slug: "theirs", id: "p2", status: "draft" });
    await writeFile(
      path.join(workspace, ".genex", "project.unlinked-1793000000000.json"),
      JSON.stringify({ slug: "mine", id: "p1", status: "published" }),
    );
    await genex.publishAppsOnly("dust", [app("Dust Runners")], "Dust Runners");
    await genex.publishWait("dust");
    assert.equal(
      (await runs()).some((call) => call.args[0] === "init"),
      false,
      "no new hosted project",
    );
    const linked = JSON.parse(await readFile(path.join(workspace, ".genex", "project.json"), "utf8"));
    assert.equal(linked.slug, "mine", "its own game is linked again");
    const aside = (await readdir(path.join(workspace, ".genex"))).filter((name) =>
      name.startsWith("project.unlinked-"),
    );
    assert.equal(aside.length, 1, "the other sign-in's link is set aside in its turn");
  });

  it("puts back no link set aside that Genex can't vouch for: a new game is made instead", async () => {
    const server = await startGenexFixtureApi((req, reply) => {
      if (req.url === "/api/auth/get-session") return reply.json({ user: { id: "u-me", email: "me@example.invalid" } });
      if (req.url.startsWith("/api/projects/by-slug/flaky")) return reply.json({ error: "down" }, 503);
    });
    servers.push(server);
    const { genex, runs } = await toolsWithStandIn(true, server.url);
    const workspace = await linkedTo(genex, { slug: "gone", id: "p3", status: "draft" });
    await writeFile(
      path.join(workspace, ".genex", "project.unlinked-1793000000000.json"),
      JSON.stringify({ slug: "flaky", id: "p1", status: "published" }),
    );
    await genex.publishAppsOnly("dust", [app("Dust Runners")], "Dust Runners");
    await genex.publishWait("dust");
    assert.equal((await runs())[0]?.args[0], "init", "a new hosted project, not a link Genex didn't answer for");
  });

  it("keeps the apps live but fails the publish when Genex refuses the listing, in its words", async () => {
    const { genex } = await toolsWithStandIn(true, await fixtureApi());
    await genex.publishAppsOnly("dust", [app("Refused")], "Dust Runners");
    const state = await genex.publishWait("dust");
    assert.equal(state.job?.state, "failed");
    assert.equal(state.job?.error, "The title reads as an ad.");
    assert.equal(state.native?.sent.length, 1, "the build itself is live");
    assert.equal(state.status, "draft");
  });

  it("says a held listing, and fails when no app went", async () => {
    const held = await toolsWithStandIn(true, await fixtureApi());
    await held.genex.publishAppsOnly("dust", [app("Held")], "Dust Runners");
    const waiting = await held.genex.publishWait("dust");
    assert.equal(waiting.job?.state, "done");
    assert.deepEqual(waiting.native?.listing, { state: "held", detail: null });
    assert.notEqual(waiting.status, "published");
    const broken = await toolsWithStandIn(true, await fixtureApi());
    await broken.genex.publishAppsOnly("dust", [{ target: "/game/Builds/Windows Broken", platform: "windows" }]);
    const failed = await broken.genex.publishWait("dust");
    assert.equal(failed.job?.state, "failed");
    assert.equal(failed.job?.error, "Couldn't get an upload token (HTTP 413).");
  });

  it("is held, never listed, while Genex reviews the app it went with", async () => {
    const { genex } = await toolsWithStandIn(true, await fixtureApi());
    await genex.publishAppsOnly("dust", [app("Review")], "Dust Runners");
    const state = await genex.publishWait("dust");
    assert.equal(state.job?.state, "done", JSON.stringify(state.job));
    assert.equal(state.native?.sent[0]?.review, "pending");
    assert.deepEqual(state.native?.listing, { state: "held", detail: null });
    assert.notEqual(state.status, "published", "its page is not found until Genex approves it");
  });

  it("sends the agent's kept cover once the apps are on Genex", async () => {
    const { genex, runs } = await toolsWithStandIn(true, await fixtureApi());
    await keepCover(genex);
    await genex.publishAppsOnly("dust", [app("Dust Runners")], "Dust Runners");
    await genex.publishWait("dust");
    // The cover goes on its own after the job is recorded: wait for its send to be written.
    const sentCover = async () => (await runs()).some((call) => call.args[0] === "cover" && call.args[1] !== "--json");
    for (let tries = 0; tries < 100 && !(await sentCover()); tries++) await sleep(50);
    const state = await genex.publishWait("dust");
    assert.equal(state.job?.state, "done", JSON.stringify(state.job));
    assert.equal(state.cover?.shot?.width, 1920);
    assert.equal(state.cover?.last?.kind, "applied", JSON.stringify(state.cover?.last));
    assert.equal(state.cover?.last?.jobId, state.job?.id);
    const order = (await runs()).map((call) => call.args[0]);
    assert.ok(order.lastIndexOf("native") < order.lastIndexOf("cover"), "the apps go before the cover");
  });

  /** Publish a game with only apps that kept a clip, with the stand-in answering its clip `clipAnswer`. */
  async function publishWithClip(clipAnswer: typeof CLIP_APPLIED | typeof CLIP_STALE) {
    const { genex, runs } = await toolsWithStandIn(true, await fixtureApi(), clipAnswer);
    const clip = { video: Buffer.from("mp4 bytes"), mimeType: "video/mp4" as const, width: 960, height: 540 };
    await saveClip(
      path.join(genex.root, GENEX_COVERS_DIR, "dust"),
      { ...clip, durationMs: 5500 },
      new Date().toISOString(),
    );
    await keepCover(genex);
    await genex.publishAppsOnly("dust", [app("Dust Runners")], "Dust Runners");
    const clipSend = async () => (await runs()).find((call) => call.args[0] === "cover" && call.args[1] === "--clip");
    for (let tries = 0; tries < 100 && !(await clipSend()); tries++) await sleep(50);
    for (let tries = 0; tries < 100 && !(await genex.publishWait("dust")).cover?.clipLast; tries++) await sleep(50);
    return { sent: await clipSend(), state: await genex.publishWait("dust") };
  }

  it("sends its kept clip as footage of the app it published, named by the archive's hash", async () => {
    const { sent, state } = await publishWithClip(CLIP_APPLIED);
    assert.ok(sent, "the clip goes after the still");
    assert.equal(sent.args[sent.args.indexOf("--commit") + 1], ARCHIVE_SHA256.slice(0, 40));
    assert.equal(state.cover?.last?.kind, "applied", "the still goes as before");
    assert.equal(state.cover?.clipLast?.kind, "applied");
  });

  it("keeps the still and the publish when Genex does not take a clip of an app yet", async () => {
    const { sent, state } = await publishWithClip(CLIP_STALE);
    assert.ok(sent);
    assert.equal(state.job?.state, "done", JSON.stringify(state.job));
    assert.equal(state.cover?.last?.kind, "applied");
    assert.equal(state.cover?.clipLast?.kind, "failed", "not settled: the next publish sends it again");
  });

  it("publishes its apps with no cover sent when the agent kept none", async () => {
    const { genex, runs } = await toolsWithStandIn(true, await fixtureApi());
    await genex.publishAppsOnly("dust", [app("Dust Runners")], "Dust Runners");
    const state = await genex.publishWait("dust");
    assert.equal(state.job?.state, "done", JSON.stringify(state.job));
    assert.equal(state.cover?.shot, null);
    assert.ok(
      !(await runs()).some((call) => call.args[0] === "cover" && call.args[1] !== "--json"),
      "nothing uploaded",
    );
  });

  it("refuses a publish with no app, or with a CLI that cannot send apps", async () => {
    const { genex } = await toolsWithStandIn(true, await fixtureApi());
    await assert.rejects(genex.publishAppsOnly("dust", []), /no Mac, Windows or Linux app/);
    const older = await toolsWithStandIn(false, await fixtureApi());
    await assert.rejects(older.genex.publishAppsOnly("dust", [app("Dust Runners")]), /no Mac, Windows or Linux app/);
  });
});
