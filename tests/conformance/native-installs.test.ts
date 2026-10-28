/**
 * Play's native installer on a real Mac's tools: a game's archive downloaded, checked and unpacked
 * into Genex's own folder, its app given a bundle id of Genex's and signed again, one install at a
 * time, the rest queued. Anything off (a link out of the game, no signature, the wrong processor,
 * too little space, a stop) leaves no game folder behind, and removing a game keeps its saves.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import genexManifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { type InstallOutcome, nativeInstalls, SAVES } from "../../src/main/play/native-installs.ts";
import { GAME_BUNDLE_PREFIX, runTool, type ToolRun, WINDOWED_KEY } from "../../src/main/play/native-unpack.ts";
import type { PlayGameDetail } from "../../src/shared/play.ts";
import {
  InstallFailure,
  InstallPhase,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  type NativeInstalls,
  NativePlatform,
} from "../../src/shared/play-native.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { writeZip, type ZipItem } from "../helpers/zip-writer.ts";

const exec = promisify(execFile);
const SKIP = process.platform === "darwin" ? false : "unpacks and signs with macOS's own tools";
const HOST = "builds.example.test";
const THIS_MAC: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.Arm64, osVersion: "15.0" };
const GB = 1024 ** 3;
/** A developer folder that is not there: every tool that asks Xcode for itself (`lipo`, `git`) then fails. */
const NO_DEVELOPER_TOOLS = "/nonexistent-developer-tools";

/**
 * {@link runTool} on a Mac without Apple's developer tools: the tools in /usr/bin that only stand in
 * for Xcode's (`lipo`, `git`) fail as they do there, and macOS's own (`ditto`, `codesign`) run.
 */
const withoutDeveloperTools: ToolRun = (file, args, options) =>
  new Promise((resolve) => {
    const env = { ...process.env, DEVELOPER_DIR: NO_DEVELOPER_TOOLS };
    execFile(file, args, { timeout: options.timeoutMs, env }, (error, stdout, stderr) => {
      const exited = error && typeof error.code === "number" ? error.code : null;
      resolve({ code: error ? exited : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** A minimal app: `/usr/bin/true` as its program (both processors), signed ad hoc unless `unsigned`. */
async function makeApp(
  dir: string,
  title: string,
  options: { unsigned?: boolean; intelOnly?: boolean; windowed?: boolean } = {},
) {
  const app = path.join(dir, `${title}.app`);
  await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
  const program = path.join(app, "Contents", "MacOS", "Game");
  if (options.intelOnly) await exec("/usr/bin/lipo", ["/usr/bin/true", "-thin", "x86_64", "-output", program]);
  else await cp("/usr/bin/true", program);
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Game</string><key>CFBundleIdentifier</key><string>com.googlecode.iterm2</string><key>CFBundleName</key><string>${title}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
  await writeFile(path.join(app, "Contents", "Info.plist"), plist);
  // What the agent does for a game that should open in a window: one key in its Info.plist.
  if (options.windowed)
    await exec("/usr/bin/plutil", ["-insert", WINDOWED_KEY, "-bool", "YES", path.join(app, "Contents", "Info.plist")]);
  if (options.unsigned) await exec("/usr/bin/codesign", ["--remove-signature", program]);
  else await exec("/usr/bin/codesign", ["--sign", "-", "--force", "--deep", app]);
  return app;
}

/** `app` zipped as ditto does for a release. */
async function zipApp(app: string, zip: string): Promise<Buffer> {
  await exec("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
  return readFile(zip);
}

/** A catalog row for `archive`. */
const buildOf = (slug: string, archive: Buffer, overrides: Partial<NativeBuild> = {}): NativeBuild => ({
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  version: "1.0",
  sizeBytes: archive.length,
  installedBytes: archive.length * 4 + 1024 ** 2,
  sha256: createHash("sha256").update(archive).digest("hex"),
  url: `https://${HOST}/${slug}/1.0/mac.zip`,
  entry: "Dust Runners.app",
  publishedAt: "2026-10-18T00:00:00.000Z",
  ...overrides,
});

/** A game's page with `builds`, as the catalog answers it. */
const page = (slug: string, builds: NativeBuild[]): PlayGameDetail => ({
  id: `id-${slug}`,
  slug,
  title: slug.replace(/-/g, " "),
  description: "",
  coverUrl: null,
  clipUrl: null,
  multiplayer: false,
  plays: 0,
  online: null,
  author: { id: null, name: "Kir", imageUrl: null },
  remixable: false,
  assetKind: null,
  native: { web: false, engine: "unity", builds },
  likes: 0,
  liked: false,
  comments: 0,
  shots: [],
  updatedAt: null,
});

/** An installer over a fresh folder, a catalog of `games` and a host serving `files` by address. */
async function installer(
  games: Record<string, NativeBuild[]>,
  files: Map<string, Buffer>,
  options: {
    free?: number;
    inUse?: (slug: string) => boolean;
    hold?: Promise<void>;
    onPush?: (state: NativeInstalls) => void;
    run?: ToolRun;
    host?: NativeHost;
  } = {},
) {
  const root = path.join(await realpath(await tmpDir("native-installs-")), "installed-games");
  const pushes: NativeInstalls[] = [];
  const outcomes: InstallOutcome[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const data = files.get(String(input));
    if (!data) return new Response(null, { status: 404 });
    const signal = init?.signal;
    // As a real fetch does, a stopped request goes no further.
    signal?.throwIfAborted();
    const hold = options.hold;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        controller.enqueue(data.subarray(0, 16));
        if (hold) await hold;
        if (signal?.aborted) return controller.error(signal.reason);
        controller.enqueue(data.subarray(16));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-length": String(data.length) } });
  }) as typeof fetch;
  const installs = nativeInstalls({
    root,
    host: options.host ?? THIS_MAC,
    hosts: new Set([HOST]),
    game: async (slug) => page(slug, games[slug] ?? []),
    fetch: fetchImpl,
    run: options.run ?? runTool,
    freeBytes: async () => options.free ?? 100 * GB,
    now: Date.now,
    publish: (state) => {
      pushes.push(state);
      options.onPush?.(state);
    },
    outcome: (outcome) => outcomes.push(outcome),
    ...(options.inUse ? { inUse: options.inUse } : {}),
  });
  return { installs, root, pushes, outcomes };
}

const plistValue = async (app: string, key: string) =>
  (
    await exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path.join(app, "Contents/Info.plist")])
  ).stdout.trim();

/** What is in `root`, apart from the index and the download folder. */
const gameFolders = async (root: string) =>
  (await readdir(root).catch(() => [] as string[])).filter((name) => name !== "index.json" && name !== ".downloads");

describe("Play's native installer", { skip: SKIP }, () => {
  it("installs a game: downloaded, checked, unpacked, made Genex's and recorded", async () => {
    const work = await tmpDir("native-app-");
    const archive = await zipApp(await makeApp(work, "Dust Runners"), path.join(work, "game.zip"));
    const build = buildOf("dust-runners", archive);
    const { installs, root, pushes, outcomes } = await installer(
      { "dust-runners": [build] },
      new Map([[build.url, archive]]),
    );
    await installs.install("dust-runners");
    await installs.idle();
    const phases = pushes.flatMap((state) => state.progress.map((one) => one.phase));
    for (const phase of [InstallPhase.Queued, InstallPhase.Downloading, InstallPhase.Verifying, InstallPhase.Unpacking])
      assert.ok(phases.includes(phase), `${phase} was shown`);
    const state = await installs.state();
    assert.deepEqual(state.progress, []);
    assert.equal(state.installed[0]?.slug, "dust-runners");
    assert.equal(state.installed[0]?.version, "1.0");
    assert.ok((state.installed[0]?.bytes ?? 0) > 0);
    const app = path.join(root, "dust-runners", "1.0", "Dust Runners.app");
    assert.equal(
      await plistValue(app, "CFBundleIdentifier"),
      `${GAME_BUNDLE_PREFIX}dust-runners`,
      "never another app's id",
    );
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    assert.deepEqual((await readdir(path.join(root, "dust-runners"))).sort(), ["1.0", SAVES]);
    assert.deepEqual(outcomes, [
      {
        slug: "dust-runners",
        title: "dust runners",
        version: "1.0",
        platform: NativePlatform.Mac,
        failure: null,
        neededBytes: build.sizeBytes + build.installedBytes,
      },
    ]);
    const record = await installs.record("dust-runners");
    assert.equal(record?.executable, "Contents/MacOS/Game");
    assert.equal(record?.bundleName, "Dust Runners");
    assert.deepEqual([record?.engine, record?.windowed], ["unity", false], "it opens full screen in Unity's way");
    assert.deepEqual(await readdir(path.join(root, ".downloads")), [], "the archive is not kept");
    await installs.install("dust-runners");
    await installs.idle();
    assert.equal(outcomes.length, 1, "installing the same version again does nothing");
  });

  it("records that a game asks for a window, and reads an older record as one that opens full screen", async () => {
    const work = await tmpDir("native-app-");
    const archive = await zipApp(await makeApp(work, "Dust Runners", { windowed: true }), path.join(work, "game.zip"));
    const build = buildOf("dust-runners", archive);
    const { installs, root } = await installer({ "dust-runners": [build] }, new Map([[build.url, archive]]));
    await installs.install("dust-runners");
    await installs.idle();
    assert.equal((await installs.record("dust-runners"))?.windowed, true);
    const skill = genexManifest.skills.find((one) => one.name === "publishing-apps");
    assert.match(
      skill && "text" in skill ? String(skill.text) : "",
      new RegExp(WINDOWED_KEY),
      "the agent is told the key",
    );
    const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
    const { engine: _engine, windowed: _windowed, ...older } = index.games["dust-runners"];
    await writeFile(path.join(root, "index.json"), JSON.stringify({ ...index, games: { "dust-runners": older } }));
    const again = nativeInstalls({
      root,
      host: THIS_MAC,
      hosts: new Set([HOST]),
      game: async (slug) => page(slug, [build]),
      fetch,
      run: runTool,
      now: Date.now,
      publish: () => {},
      outcome: () => {},
    });
    const read = await again.record("dust-runners");
    assert.deepEqual([read?.engine, read?.windowed], [null, false]);
  });

  it("installs an app zipped as `genex native publish` packs it, its extended attributes set aside", async () => {
    const work = await tmpDir("native-app-");
    const app = await makeApp(work, "Dust Runners");
    // The CLI zips with ditto --sequesterRsrc: a file's extended attributes travel as __MACOSX/._ entries.
    await exec("/usr/bin/xattr", [
      "-w",
      "com.apple.metadata:kMDItemWhereFroms",
      "genex",
      path.join(app, "Contents/Info.plist"),
    ]);
    const zip = path.join(work, "Dust-Runners.app.zip");
    await exec("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
    const archive = await readFile(zip);
    const listed = await exec("/usr/bin/unzip", ["-Z1", zip]);
    assert.match(listed.stdout, /^__MACOSX\//m, "the archive carries the attributes beside the app");
    const build = buildOf("dust-runners", archive);
    const { installs, root, outcomes } = await installer({ "dust-runners": [build] }, new Map([[build.url, archive]]));
    await installs.install("dust-runners");
    await installs.idle();
    assert.equal(outcomes[0]?.failure, null);
    assert.deepEqual(await readdir(path.join(root, "dust-runners", "1.0")), ["Dust Runners.app"]);
    await exec("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      path.join(root, "dust-runners", "1.0", "Dust Runners.app"),
    ]);
  });

  it("installs an app packed on Windows, whose program lost its execute bit, ready to run", async () => {
    const work = await tmpDir("native-app-");
    const app = await makeApp(work, "Dust Runners");
    await chmod(path.join(app, "Contents", "MacOS", "Game"), 0o644);
    const archive = await zipApp(app, path.join(work, "mac.zip"));
    const build = buildOf("dust-runners", archive);
    const { installs, root, outcomes } = await installer({ "dust-runners": [build] }, new Map([[build.url, archive]]));
    await installs.install("dust-runners");
    await installs.idle();
    assert.equal(outcomes[0]?.failure, null);
    const program = path.join(root, "dust-runners", "1.0", "Dust Runners.app", "Contents", "MacOS", "Game");
    assert.equal((await stat(program)).mode & 0o111, 0o111);
  });

  it("installs on a Mac without Apple's developer tools, an Intel-only game through Rosetta", async () => {
    const work = await tmpDir("native-app-");
    const universal = await zipApp(await makeApp(work, "Dust Runners"), path.join(work, "universal.zip"));
    const intel = await zipApp(
      await makeApp(path.join(work, "i"), "Dust Runners", { intelOnly: true }),
      path.join(work, "intel.zip"),
    );
    const cases: Array<[string, Buffer, NativeHost]> = [
      ["a universal app", universal, THIS_MAC],
      ["an Intel-only app, with Rosetta", intel, { ...THIS_MAC, rosetta: true }],
    ];
    for (const [why, archive, host] of cases) {
      const build = buildOf("dust-runners", archive);
      const { installs, outcomes } = await installer({ "dust-runners": [build] }, new Map([[build.url, archive]]), {
        run: withoutDeveloperTools,
        host,
      });
      await installs.install("dust-runners");
      await installs.idle();
      assert.equal(outcomes[0]?.failure, null, why);
      assert.equal((await installs.state()).installed[0]?.slug, "dust-runners", why);
    }
  });

  it("fails each bad archive with its reason and leaves no game folder", async () => {
    const work = await tmpDir("native-app-");
    const good = await zipApp(await makeApp(work, "Dust Runners"), path.join(work, "good.zip"));
    const unsigned = await zipApp(
      await makeApp(path.join(work, "u"), "Dust Runners", { unsigned: true }),
      path.join(work, "unsigned.zip"),
    );
    const intel = await zipApp(
      await makeApp(path.join(work, "i"), "Dust Runners", { intelOnly: true }),
      path.join(work, "intel.zip"),
    );
    const chain: ZipItem[] = [
      { name: "Dust Runners.app/Contents/Info.plist", data: "<plist/>" },
      { name: "Dust Runners.app/d/e/b", link: ".." },
      { name: "Dust Runners.app/a", link: "d/e/b/../../.." },
    ];
    const cases: Array<[string, Buffer, Partial<NativeBuild>, InstallFailure]> = [
      ["a checksum that does not match", good, { sha256: "0".repeat(64) }, InstallFailure.Checksum],
      ["no signature", unsigned, {}, InstallFailure.Unsigned],
      ["only for Intel, with no Rosetta", intel, {}, InstallFailure.NeedsRosetta],
      ["another app than the catalog names", good, { entry: "Other.app" }, InstallFailure.EntryMissing],
      ["a climb out of the archive", writeZip([{ name: "../evil", data: "x" }]), {}, InstallFailure.UnsafeArchive],
      ["a chain of links out of the game", writeZip(chain), {}, InstallFailure.UnsafeArchive],
      [
        "more unpacked than stated",
        writeZip([{ name: "Dust Runners.app/Contents/big", data: Buffer.alloc(80 * 1024 ** 2), deflate: true }]),
        { installedBytes: 10 },
        InstallFailure.TooLarge,
      ],
    ];
    for (const [why, archive, overrides, failure] of cases) {
      const build = { ...buildOf("dust-runners", archive), ...overrides };
      const { installs, root, outcomes } = await installer(
        { "dust-runners": [build] },
        new Map([[build.url, archive]]),
      );
      await installs.install("dust-runners");
      await installs.idle();
      assert.equal(outcomes[0]?.failure, failure, why);
      const state = await installs.state();
      assert.equal(state.progress[0]?.phase, InstallPhase.Failed, why);
      assert.equal(state.progress[0]?.failure, failure, why);
      assert.deepEqual(state.installed, [], why);
      assert.deepEqual(
        (await gameFolders(root)).filter((name) => name !== "dust-runners"),
        [],
        `${why}: nothing unpacked is left`,
      );
      assert.deepEqual(await readdir(path.join(root, "dust-runners")).catch(() => []), [], `${why}: no version folder`);
    }
  });

  it("installs nothing without the space for the download, the game and a reserve, or a build for this Mac", async () => {
    const work = await tmpDir("native-app-");
    const archive = await zipApp(await makeApp(work, "Dust Runners"), path.join(work, "game.zip"));
    const build = buildOf("dust-runners", archive);
    const full = await installer({ "dust-runners": [build] }, new Map([[build.url, archive]]), { free: GB });
    await full.installs.install("dust-runners");
    await full.installs.idle();
    assert.equal(full.outcomes[0]?.failure, InstallFailure.NoSpace);
    const windows = { ...build, platform: NativePlatform.Windows, arch: NativeArch.X64, entry: "Dust.exe" };
    const elsewhere = await installer({ "dust-runners": [windows] }, new Map());
    await elsewhere.installs.install("dust-runners");
    assert.equal(elsewhere.outcomes[0]?.failure, InstallFailure.NotOffered);
    await assert.rejects(elsewhere.installs.install("../evil"), /not a game address/);
  });

  it("runs one install at a time, queues the next, and a stop leaves nothing behind", async () => {
    const work = await tmpDir("native-app-");
    const archive = await zipApp(await makeApp(work, "Dust Runners"), path.join(work, "game.zip"));
    const first = buildOf("dust-runners", archive);
    const second = buildOf("puck-rush", archive, { url: `https://${HOST}/puck-rush/1.0/mac.zip` });
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { installs, root } = await installer(
      { "dust-runners": [first], "puck-rush": [second] },
      new Map([
        [first.url, archive],
        [second.url, archive],
      ]),
      {
        hold,
        onPush: (state) => {
          if (state.progress.some((one) => one.phase === InstallPhase.Downloading)) started();
        },
      },
    );
    await installs.install("dust-runners");
    await installs.install("puck-rush");
    const waiting = (await installs.state()).progress.find((one) => one.slug === "puck-rush");
    assert.equal(waiting?.phase, InstallPhase.Queued, "the second waits for the first");
    await downloading;
    await installs.cancel("dust-runners");
    release();
    await installs.idle();
    const state = await installs.state();
    assert.deepEqual(
      state.installed.map((game) => game.slug),
      ["puck-rush"],
    );
    assert.deepEqual(state.progress, [], "a stopped install is not a failure");
    assert.deepEqual(await readdir(path.join(root, ".downloads")), [], "its bytes are thrown away");
    assert.deepEqual(await readdir(path.join(root, "dust-runners")).catch(() => []), []);
  });

  it("updates to a new version, keeping the old one while the game runs, and removing keeps saves", async () => {
    const work = await tmpDir("native-app-");
    const archive = await zipApp(await makeApp(work, "Dust Runners"), path.join(work, "game.zip"));
    const v1 = buildOf("dust-runners", archive);
    const v2 = buildOf("dust-runners", archive, { version: "1.1", url: `https://${HOST}/dust-runners/1.1/mac.zip` });
    const games: Record<string, NativeBuild[]> = { "dust-runners": [v1] };
    let running = false;
    const { installs, root } = await installer(
      games,
      new Map([
        [v1.url, archive],
        [v2.url, archive],
      ]),
      { inUse: () => running },
    );
    await installs.install("dust-runners");
    await installs.idle();
    await writeFile(path.join(root, "dust-runners", SAVES, "slot1.sav"), "level 3");
    games["dust-runners"] = [v2];
    running = true;
    await installs.install("dust-runners");
    await installs.idle();
    assert.equal((await installs.record("dust-runners"))?.version, "1.1");
    assert.deepEqual((await readdir(path.join(root, "dust-runners"))).sort(), ["1.0", "1.1", SAVES], "1.0 runs still");
    await assert.rejects(installs.uninstall("dust-runners"), /quit the game/);
    running = false;
    await installs.sweep("dust-runners");
    assert.deepEqual((await readdir(path.join(root, "dust-runners"))).sort(), ["1.1", SAVES]);
    await installs.uninstall("dust-runners");
    assert.deepEqual((await installs.state()).installed, []);
    assert.deepEqual(await readdir(path.join(root, "dust-runners")), [SAVES]);
    assert.equal(await readFile(path.join(root, "dust-runners", SAVES, "slot1.sav"), "utf8"), "level 3");
  });

  it("clears what a quit left mid-install at the next start", async () => {
    const { installs, root } = await installer({}, new Map());
    await mkdir(path.join(root, ".incoming-abc", "game", "Dust Runners.app"), { recursive: true });
    await mkdir(path.join(root, "dust-runners", "0.9"), { recursive: true });
    await mkdir(path.join(root, "dust-runners", SAVES), { recursive: true });
    await installs.reconcile();
    assert.deepEqual(await gameFolders(root), ["dust-runners"]);
    assert.deepEqual(await readdir(path.join(root, "dust-runners")), [SAVES], "a version the index does not name goes");
  });
});
