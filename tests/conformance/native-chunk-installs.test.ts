/**
 * Play's native installer with a chunked build: the manifest read and checked, the chunks assembled
 * in a work folder and the game then checked and recorded exactly as an unpacked zip is. An update
 * downloads only the chunks the installed version cannot give it, an interrupted install does only
 * the rest, and nothing a hostile manifest or chunk says is ever written outside the work folder.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { parseManifest } from "../../src/main/play/native-chunks.ts";
import {
  INSTALL_RESERVE_BYTES,
  type InstallOutcome,
  KEPT_MANIFEST,
  nativeInstalls,
  SAVES,
} from "../../src/main/play/native-installs.ts";
import { GAME_BUNDLE_PREFIX, runTool } from "../../src/main/play/native-unpack.ts";
import type { PlayGameDetail } from "../../src/shared/play.ts";
import {
  type ChunkedBuild,
  InstallFailure,
  InstallPhase,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  type NativeInstalls,
  NativePlatform,
} from "../../src/shared/play-native.ts";
import { elfX64, hostileChunks, hostileManifests, noise, soundGame } from "../helpers/chunk-hostile.ts";
import {
  type ChunkAnswer,
  type ChunkedGame,
  type ChunkItem,
  chunkedGame,
  chunkFetch,
  itemsOf,
  storedChunk,
} from "../helpers/chunk-store.ts";
import { makeApp } from "../helpers/mac-app.ts";
import { PeMachine, peImageBytes } from "../helpers/pe-image.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { writeZip } from "../helpers/zip-writer.ts";

const exec = promisify(execFile);
const SKIP = process.platform === "win32" ? "a Linux build's links and execute bits need a unix disk" : false;
const MAC_SKIP = process.platform === "darwin" ? false : "checks and signs with macOS's own tools";
const HOST = "builds.example.test";
const LINUX_PC: NativeHost = { platform: NativePlatform.Linux, arch: NativeArch.X64, osVersion: "6.8.0" };
const THIS_MAC: NativeHost = { platform: NativePlatform.Mac, arch: NativeArch.Arm64, osVersion: "15.0" };
const WINDOWS_PC: NativeHost = { platform: NativePlatform.Windows, arch: NativeArch.X64, osVersion: "10.0.22631" };
const GB = 1024 ** 3;
const SLUG = "dust-runners";
const ENTRY = "Dust Runners/Dust.x86_64";
const RUNNABLE = 0o111;

/** Where a game's chunks are: one folder a game, on the build host. */
const folderOf = (slug: string): string => `https://${HOST}/games/${slug}/native/chunks/`;

/** A chunked Linux build's row for `game`. */
const rowOf = (game: ChunkedGame, overrides: Partial<ChunkedBuild> = {}): ChunkedBuild => ({
  platform: NativePlatform.Linux,
  arch: NativeArch.X64,
  version: "1.0",
  sizeBytes: game.sizeBytes,
  installedBytes: game.installedBytes,
  sha256: game.sha256,
  chunksUrl: folderOf(SLUG),
  entry: ENTRY,
  publishedAt: "2026-11-12T00:00:00.000Z",
  ...overrides,
});

/** A game's page with `builds`, as the catalog answers it. */
const page = (slug: string, builds: NativeBuild[]): PlayGameDetail => ({
  id: `id-${slug}`,
  slug,
  title: "Dust Runners",
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

interface RigOptions {
  /** The catalog: each game's builds, changed by a test to publish an update. */
  games: Record<string, NativeBuild[]>;
  /** The build host: each chunk folder's objects by name. */
  objects: Map<string, Buffer>;
  /** An installed-games folder an earlier installer left, as after a restart. */
  root?: string;
  host?: NativeHost;
  answer?: ChunkAnswer;
  free?: () => number;
  onPush?: (state: NativeInstalls) => void;
}

/** An installer over a fresh folder (or `root`), a catalog and a build host that keeps what it was asked. */
async function rig(options: RigOptions) {
  const root = options.root ?? path.join(await realpath(await tmpDir("native-chunks-")), "installed-games");
  const pushes: NativeInstalls[] = [];
  const outcomes: InstallOutcome[] = [];
  const waits: number[] = [];
  const folders = new Map<string, Map<string, Buffer>>();
  for (const slug of Object.keys(options.games)) folders.set(folderOf(slug), options.objects);
  const store = chunkFetch(folders, options.answer);
  // Each look at the clock is a second later: no progress push is held back.
  let clock = Date.parse("2026-11-12T00:00:00.000Z");
  const installs = nativeInstalls({
    root,
    host: options.host ?? LINUX_PC,
    hosts: new Set([HOST]),
    game: async (slug) => page(slug, options.games[slug] ?? []),
    fetch: store.fetchImpl,
    run: runTool,
    freeBytes: async () => options.free?.() ?? 100 * GB,
    now: () => {
      clock += 1000;
      return clock;
    },
    publish: (state) => {
      pushes.push(state);
      options.onPush?.(state);
    },
    outcome: (outcome) => outcomes.push(outcome),
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const install = async (slug = SLUG) => {
    await installs.install(slug);
    await installs.idle();
    return outcomes.at(-1)?.failure;
  };
  return { installs, install, root, pushes, outcomes, store, waits };
}

/** The installed files of `items` under `dir`, read back: each regular file's bytes by path. */
async function installedFiles(dir: string, items: readonly ChunkItem[]): Promise<Record<string, Buffer>> {
  const read: Record<string, Buffer> = {};
  for (const item of items) {
    if (item.link === undefined && !item.dir) read[item.path] = await readFile(path.join(dir, item.path));
  }
  return read;
}

/** What `items` say each regular file holds. */
const statedFiles = (items: readonly ChunkItem[]): Record<string, Buffer> =>
  Object.fromEntries(
    items
      .filter((item) => item.link === undefined && !item.dir)
      .map((item) => [item.path, Buffer.from(item.data ?? "")]),
  );

/** The chunk requests a store saw, sorted, and the same for the chunks expected. */
const sorted = (hashes: Iterable<string>): string[] => [...hashes].sort();

/** The first version of the game the update tests install: 26 chunks of 64 bytes. */
const firstVersion = (): ChunkItem[] => [
  { path: ENTRY, data: elfX64(), exec: true },
  { path: "Dust Runners/Dust_Data/level0", data: noise(640, 1) },
  { path: "Dust Runners/Dust_Data/level1", data: noise(640, 2) },
  { path: "Dust Runners/UnityPlayer.so", data: noise(320, 3) },
];

/** The second: ten bytes of `level1` changed in place (one chunk) and a new file at the end (four more). */
function secondVersion(): ChunkItem[] {
  const level1 = noise(640, 2);
  level1.fill(0x5a, 100, 110);
  return [
    { path: ENTRY, data: elfX64(), exec: true },
    { path: "Dust Runners/Dust_Data/level0", data: noise(640, 1) },
    { path: "Dust Runners/Dust_Data/level1", data: level1 },
    { path: "Dust Runners/UnityPlayer.so", data: noise(320, 3) },
    { path: "Dust Runners/zz_new.pak", data: noise(200, 5) },
  ];
}

/** The hashes of `game`'s chunks that `before` does not have. */
function newChunks(game: ChunkedGame, before: ChunkedGame): string[] {
  const had = new Set(before.manifest.chunks.map((chunk) => chunk.hash));
  return game.manifest.chunks.map((chunk) => chunk.hash).filter((hash) => !had.has(hash));
}

/** `game`'s manifest and only the chunks named: a host that could not serve any other chunk. */
function onlyChunks(game: ChunkedGame, hashes: Iterable<string>): Map<string, Buffer> {
  const names = new Set([`${game.sha256}.manifest.json`, ...[...hashes].map((hash) => `${hash}.bin`)]);
  return new Map([...game.objects].filter(([name]) => names.has(name)));
}

describe("Play's native installer with a chunked build", { skip: SKIP }, () => {
  it("installs a fresh Linux build: its files, programs, empty folder and link as the manifest says", async () => {
    const items = soundGame();
    const game = chunkedGame(items);
    const { installs, install, root, pushes, outcomes, store } = await rig({
      games: { [SLUG]: [rowOf(game)] },
      objects: game.objects,
    });
    assert.equal(await install(), null);
    assert.deepEqual(outcomes, [
      {
        slug: SLUG,
        title: "Dust Runners",
        version: "1.0",
        platform: NativePlatform.Linux,
        failure: null,
        neededBytes: game.installedBytes,
      },
    ]);
    const version = path.join(root, SLUG, "1.0");
    assert.deepEqual(await installedFiles(version, items), statedFiles(items));
    assert.equal((await lstat(path.join(version, ENTRY))).mode & RUNNABLE, RUNNABLE, "the program runs");
    assert.equal((await lstat(path.join(version, "Dust Runners/UnityPlayer.so"))).mode & RUNNABLE, 0);
    assert.equal(await readlink(path.join(version, "Dust Runners/current")), "Dust_Data");
    assert.deepEqual(await readdir(path.join(version, "Dust Runners/Empty")), []);
    const record = await installs.record(SLUG);
    assert.deepEqual(
      [record?.platform, record?.entry, record?.executable, record?.bundleId, record?.manifestSha256],
      [NativePlatform.Linux, ".", ENTRY, `${GAME_BUNDLE_PREFIX}${SLUG}`, game.sha256],
    );
    assert.deepEqual((await readdir(path.join(root, SLUG))).sort(), [KEPT_MANIFEST, "1.0", SAVES]);
    assert.deepEqual(await readFile(path.join(root, SLUG, KEPT_MANIFEST)), game.manifestBytes);
    assert.deepEqual(await readdir(path.join(root, ".downloads")), [], "the work folder is gone");
    const everyObject = [...game.objects.keys()].map((name) => `${folderOf(SLUG)}${name}`);
    assert.deepEqual(sorted(store.asked), sorted(everyObject), "the manifest and each chunk, once");
    const progress = pushes.flatMap((state) => state.progress);
    const phases = new Set(progress.map((one) => one.phase));
    for (const phase of [InstallPhase.Queued, InstallPhase.Downloading, InstallPhase.Verifying, InstallPhase.Unpacking])
      assert.ok(phases.has(phase), `${phase} was shown`);
    assert.ok(
      progress.every((one) => one.totalBytes === game.installedBytes),
      "progress counts the game's own bytes",
    );
    assert.equal(Math.max(...progress.map((one) => one.receivedBytes)), game.installedBytes);
    assert.deepEqual((await installs.state()).progress, []);
  });

  it("updates from the installed version: only the chunks it lacks are downloaded", async () => {
    const v1 = chunkedGame(firstVersion());
    const v2 = chunkedGame(secondVersion());
    const lacking = newChunks(v2, v1);
    assert.equal(v2.manifest.chunks.length, 30);
    assert.equal(lacking.length, 5, "one chunk changed in place, four are new");
    const games = { [SLUG]: [rowOf(v1)] };
    const objects = new Map(v1.objects);
    const { installs, install, root, store } = await rig({ games, objects });
    assert.equal(await install(), null);
    // The host forgets every chunk the update should not need: asking for one would fail.
    objects.clear();
    for (const [name, stored] of onlyChunks(v2, lacking)) objects.set(name, stored);
    games[SLUG] = [rowOf(v2, { version: "1.1" })];
    store.asked.length = 0;
    assert.equal(await install(), null);
    assert.deepEqual(sorted(store.askedChunks()), sorted(lacking));
    assert.equal(store.asked.length, lacking.length + 1, "and the manifest, once");
    const version = path.join(root, SLUG, "1.1");
    assert.deepEqual(await installedFiles(version, secondVersion()), statedFiles(secondVersion()));
    assert.deepEqual((await readdir(path.join(root, SLUG))).sort(), [KEPT_MANIFEST, "1.1", SAVES]);
    assert.deepEqual(await readFile(path.join(root, SLUG, KEPT_MANIFEST)), v2.manifestBytes);
    assert.equal((await installs.record(SLUG))?.manifestSha256, v2.sha256);
  });

  it("trusts no installed file that changed: its chunks are downloaded", async () => {
    const v1 = chunkedGame(firstVersion());
    const v2 = chunkedGame(secondVersion());
    const games = { [SLUG]: [rowOf(v1)] };
    const objects = new Map([...v1.objects, ...v2.objects]);
    const { install, root, store } = await rig({ games, objects });
    assert.equal(await install(), null);
    const installed = path.join(root, SLUG, "1.0", "Dust Runners");
    // Ten bytes of level0 changed in place (its first chunk, the stream's second), and the last
    // file one byte short: a file of another size gives no chunk at all (the stream's last five).
    const level0 = noise(640, 1);
    level0.fill(0x11, 0, 10);
    await writeFile(path.join(installed, "Dust_Data", "level0"), level0);
    await truncate(path.join(installed, "UnityPlayer.so"), 319);
    games[SLUG] = [rowOf(v2, { version: "1.1" })];
    store.asked.length = 0;
    assert.equal(await install(), null);
    const hashes = v2.manifest.chunks.map((chunk) => chunk.hash);
    const untrusted = [hashes[1], ...hashes.slice(21, 26)].filter((hash) => hash !== undefined);
    assert.deepEqual(sorted(store.askedChunks()), sorted([...newChunks(v2, v1), ...untrusted]));
    const version = path.join(root, SLUG, "1.1");
    assert.deepEqual(await installedFiles(version, secondVersion()), statedFiles(secondVersion()));
  });

  it("keeps the manifest through a changed link, drops it with the game, and a zip leaves none", async () => {
    const v1 = chunkedGame(firstVersion());
    const v2 = chunkedGame(secondVersion());
    const moved = "dust-racers";
    const games: Record<string, NativeBuild[]> = { [SLUG]: [rowOf(v1)], [moved]: [] };
    const objects = new Map(v1.objects);
    const { installs, install, root, store } = await rig({ games, objects });
    assert.equal(await install(), null);
    assert.equal(await installs.follow(SLUG, moved), true);
    assert.deepEqual(await readFile(path.join(root, moved, KEPT_MANIFEST)), v1.manifestBytes, "it moved with the game");
    objects.clear();
    for (const [name, stored] of onlyChunks(v2, newChunks(v2, v1))) objects.set(name, stored);
    games[moved] = [rowOf(v2, { version: "1.1", chunksUrl: folderOf(moved) })];
    store.asked.length = 0;
    assert.equal(await install(moved), null, "the update at the new link reuses the installed version");
    assert.equal(store.askedChunks().length, 5);
    // A zip of the same game replaces it: no manifest describes a zip's files.
    const archive = writeZip(firstVersion().map((item) => ({ name: item.path, data: item.data, mode: 0o100755 })));
    const zip: NativeBuild = {
      ...rowOf(v1, { version: "1.2" }),
      chunksUrl: undefined,
      url: `${folderOf(moved)}linux.zip`,
      sizeBytes: archive.length,
      installedBytes: archive.length * 4,
      sha256: createHash("sha256").update(archive).digest("hex"),
    };
    objects.set("linux.zip", archive);
    games[moved] = [zip];
    assert.equal(await install(moved), null);
    assert.deepEqual((await readdir(path.join(root, moved))).sort(), ["1.2", SAVES], "the manifest went with 1.1");
    assert.equal((await installs.record(moved))?.manifestSha256, undefined);
    // The next chunked version has nothing to take chunks from: every one is downloaded.
    const v3 = chunkedGame(secondVersion());
    objects.clear();
    for (const [name, stored] of v3.objects) objects.set(name, stored);
    games[moved] = [rowOf(v3, { version: "1.3", chunksUrl: folderOf(moved) })];
    store.asked.length = 0;
    assert.equal(await install(moved), null);
    assert.equal(store.askedChunks().length, v3.manifest.chunks.length);
    assert.deepEqual((await readdir(path.join(root, moved))).sort(), [KEPT_MANIFEST, "1.3", SAVES]);
    await installs.uninstall(moved);
    assert.deepEqual(await readdir(path.join(root, moved)), [SAVES], "removing the game removes its manifest");
  });

  it("keeps the manifest when old versions are cleared and at the next start", async () => {
    const game = chunkedGame(firstVersion());
    const { installs, install, root } = await rig({ games: { [SLUG]: [rowOf(game)] }, objects: game.objects });
    assert.equal(await install(), null);
    await installs.sweep(SLUG);
    await installs.reconcile();
    assert.deepEqual((await readdir(path.join(root, SLUG))).sort(), [KEPT_MANIFEST, "1.0", SAVES]);
  });
});

/** A game of ten chunks: a program and one file of data, and a link to it. */
const tenChunks = (): ChunkItem[] => [
  { path: ENTRY, data: elfX64(), exec: true },
  { path: "Dust Runners/data.pak", data: noise(576, 4) },
  { path: "Dust Runners/latest", link: "data.pak" },
];

/**
 * An install of {@link tenChunks} that fails after its first four chunks: the host answers the
 * other six with an error, and only once those four are finished.
 */
async function interrupted() {
  const game = chunkedGame(tenChunks());
  const hashes = game.manifest.chunks.map((chunk) => chunk.hash);
  const failing = new Set(hashes.slice(4).map((hash) => `${hash}.bin`));
  let release = () => {};
  const fourDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  const games = { [SLUG]: [rowOf(game)] };
  const first = await rig({
    games,
    objects: game.objects,
    answer: async (name) => {
      if (!failing.has(name)) return undefined;
      await fourDone;
      return new Response("no", { status: 500 });
    },
    onPush: (state) => {
      if ((state.progress[0]?.receivedBytes ?? 0) >= 4 * 64) release();
    },
  });
  assert.equal(await first.install(), InstallFailure.Network);
  const [work] = await readdir(path.join(first.root, ".downloads"));
  assert.equal(work, `${SLUG}-${game.sha256.slice(0, 16)}.chunked`, "a failure keeps the work folder");
  const dir = path.join(first.root, ".downloads", work);
  /** The same folder after a restart, the host whole again. */
  const again = () => rig({ games, objects: game.objects, root: first.root });
  return { game, hashes, root: first.root, dir, again };
}

describe("A chunked install that was interrupted", { skip: SKIP }, () => {
  it("does only the rest: the chunks it finished are checked on disk, not downloaded again", async () => {
    const { game, hashes, root, dir, again } = await interrupted();
    assert.deepEqual(sorted((await readFile(path.join(dir, "done.log"), "utf8")).split("\n").slice(1, -1)), [
      "0",
      "1",
      "2",
      "3",
    ]);
    // A try that got as far as its links leaves them behind: they are made again, last. Anything
    // else in the work folder that the manifest does not list is not the game's, and is not installed.
    await symlink("data.pak", path.join(dir, "game", "Dust Runners", "latest"));
    await mkdir(path.join(dir, "game", "Dust Runners", "Stray"));
    await writeFile(path.join(dir, "game", "Dust Runners", "Stray", "file"), "not the game's");
    await symlink("/", path.join(dir, "game", "out"));
    const second = await again();
    assert.equal(await second.install(), null);
    assert.deepEqual(sorted(second.store.askedChunks()), sorted(hashes.slice(4)));
    assert.equal(await readlink(path.join(root, SLUG, "1.0", "Dust Runners", "latest")), "data.pak");
    assert.deepEqual(await readdir(path.join(root, SLUG, "1.0")), ["Dust Runners"]);
    assert.deepEqual((await readdir(path.join(root, SLUG, "1.0", "Dust Runners"))).sort(), [
      "Dust.x86_64",
      "data.pak",
      "latest",
    ]);
    const phases = second.pushes.flatMap((state) => state.progress.map((one) => one.phase));
    assert.ok(phases.includes(InstallPhase.Verifying), "the saved chunks are checked first");
    assert.deepEqual(await installedFiles(path.join(root, SLUG, "1.0"), tenChunks()), statedFiles(tenChunks()));
    assert.deepEqual(await readdir(path.join(root, ".downloads")), []);
    assert.equal(game.manifest.chunks.length, 10);
  });

  it("catches a record ahead of the disk: a chunk it names that is not there is done again", async () => {
    const { hashes, root, dir, again } = await interrupted();
    // Chunk 2 never reached the disk (its bytes of data.pak are still empty), and chunk 7 was
    // recorded though it was never written: what a power loss can leave.
    const data = path.join(dir, "game", "Dust Runners", "data.pak");
    const bytes = await readFile(data);
    bytes.fill(0, 64, 128);
    await writeFile(data, bytes);
    await appendFile(path.join(dir, "done.log"), "7\n999999\n-1\nnoise\n3");
    const second = await again();
    assert.equal(await second.install(), null);
    assert.deepEqual(sorted(second.store.askedChunks()), sorted([hashes[2] ?? "", ...hashes.slice(4)]));
    assert.deepEqual(await installedFiles(path.join(root, SLUG, "1.0"), tenChunks()), statedFiles(tenChunks()));
  });

  it("starts afresh when the record is not this build's", async () => {
    const { hashes, root, dir, again } = await interrupted();
    await writeFile(path.join(dir, "done.log"), `genex-chunks-done 1 ${"0".repeat(64)}\n0\n1\n2\n3\n`);
    await writeFile(path.join(dir, "game", "stray"), "left by another build");
    const second = await again();
    assert.equal(await second.install(), null);
    assert.deepEqual(sorted(second.store.askedChunks()), sorted(hashes));
    assert.deepEqual(await readdir(path.join(root, SLUG, "1.0")), ["Dust Runners"], "nothing stray is installed");
  });

  it("writes through no link planted in its work folder", async () => {
    const { root, dir, again } = await interrupted();
    const outside = await tmpDir("native-chunks-outside-");
    const planted: Array<[string, () => Promise<void>]> = [
      [
        "a link where a folder of the game was",
        async () => {
          await rm(path.join(dir, "game", "Dust Runners"), { recursive: true });
          await symlink(outside, path.join(dir, "game", "Dust Runners"));
        },
      ],
      [
        "a link where a file of the game was",
        async () => {
          await rm(path.join(dir, "game", "Dust Runners"), { recursive: true });
          await mkdir(path.join(dir, "game", "Dust Runners"));
          await writeFile(path.join(outside, "target"), "");
          await symlink(path.join(outside, "target"), path.join(dir, "game", "Dust Runners", "data.pak"));
        },
      ],
    ];
    for (const [why, plant] of planted) {
      await plant();
      const second = await again();
      assert.equal(await second.install(), InstallFailure.UnsafeArchive, why);
      assert.deepEqual(
        await readdir(outside).then((names) => names.sort()),
        why.includes("file") ? ["target"] : [],
        why,
      );
      assert.equal(await readFile(path.join(outside, "target"), "utf8").catch(() => ""), "", `${why}: nothing written`);
      assert.deepEqual(await readdir(path.join(root, SLUG)).catch(() => []), [], `${why}: no version folder`);
    }
  });

  it("asks again for a chunk the host failed to give, waiting longer each time", async () => {
    const game = chunkedGame(tenChunks());
    const flaky = `${game.manifest.chunks[5]?.hash}.bin`;
    let failures = 2;
    const { install, store, waits, root } = await rig({
      games: { [SLUG]: [rowOf(game)] },
      objects: game.objects,
      answer: (name) => (name === flaky && failures-- > 0 ? new Response("busy", { status: 503 }) : undefined),
    });
    assert.equal(await install(), null);
    assert.equal(store.asked.filter((url) => url.endsWith(flaky)).length, 3);
    assert.deepEqual(waits, [1000, 2000]);
    assert.deepEqual(await installedFiles(path.join(root, SLUG, "1.0"), tenChunks()), statedFiles(tenChunks()));
  });

  it("throws the work folder away when the install is cancelled", async () => {
    const game = chunkedGame(tenChunks());
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const asked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { installs, root } = await rig({
      games: { [SLUG]: [rowOf(game)] },
      objects: game.objects,
      answer: async (name) => {
        if (!name.endsWith(".bin")) return undefined;
        started();
        await hold;
        return undefined;
      },
    });
    await installs.install(SLUG);
    await asked;
    assert.equal((await readdir(path.join(root, ".downloads"))).length, 1, "the work folder is there");
    await installs.cancel(SLUG);
    release();
    await installs.idle();
    assert.deepEqual((await installs.state()).progress, [], "a stopped install is not a failure");
    assert.deepEqual(await readdir(path.join(root, ".downloads")), [], "its bytes are thrown away");
    assert.deepEqual(await readdir(path.join(root, SLUG)).catch(() => []), []);
  });
});

/** A game of three files, each one chunk of 64 KiB: what the disk holds of it is whole files. */
const CHUNK = 64 * 1024;
const threeFiles = (): ChunkItem[] => [
  { path: ENTRY, data: Buffer.concat([elfX64(), noise(CHUNK - 64, 6)]), exec: true },
  { path: "Dust Runners/a.pak", data: noise(CHUNK, 7) },
  { path: "Dust Runners/b.pak", data: noise(CHUNK, 8) },
];

describe("A chunked install's free-space check", { skip: SKIP }, () => {
  it("asks for the game and a reserve, never for an archive beside it", async () => {
    const game = chunkedGame(threeFiles(), CHUNK);
    let free = game.installedBytes + INSTALL_RESERVE_BYTES - 1;
    const { install, store } = await rig({
      games: { [SLUG]: [rowOf(game, { sizeBytes: 50 * GB })] },
      objects: game.objects,
      free: () => free,
    });
    assert.equal(await install(), InstallFailure.NoSpace);
    assert.deepEqual(store.asked, [], "nothing is asked of the host");
    free += 1;
    assert.equal(await install(), null);
  });

  it("asks an interrupted install only for the part of the game not on disk yet", async () => {
    const game = chunkedGame(threeFiles(), CHUNK);
    const [, ...rest] = game.manifest.chunks.map((chunk) => `${chunk.hash}.bin`);
    let release = () => {};
    const firstDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    let free = 100 * GB;
    const { install } = await rig({
      games: { [SLUG]: [rowOf(game)] },
      objects: game.objects,
      free: () => free,
      answer: async (name) => {
        if (!rest.includes(name) || free !== 100 * GB) return undefined;
        await firstDone;
        return new Response("no", { status: 500 });
      },
      onPush: (state) => {
        if ((state.progress[0]?.receivedBytes ?? 0) >= CHUNK) release();
      },
    });
    assert.equal(await install(), InstallFailure.Network);
    free = INSTALL_RESERVE_BYTES + 2 * CHUNK - 1;
    assert.equal(await install(), InstallFailure.NoSpace, "the two files not written yet still need their space");
    free += 1;
    assert.equal(await install(), null, "the file already written is not asked for again");
  });
});

describe("A hostile chunked build", { skip: SKIP }, () => {
  it("installs nothing from a manifest that breaks a rule, and writes nothing", async () => {
    const sound = chunkedGame(soundGame());
    for (const [why, bytes, failure] of hostileManifests(sound.manifest)) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const objects = new Map([...sound.objects, [`${sha256}.manifest.json`, bytes]]);
      const { install, installs, root } = await rig({ games: { [SLUG]: [rowOf(sound, { sha256 })] }, objects });
      assert.equal(await install(), failure, why);
      assert.equal(await installs.record(SLUG), null, `${why}: not recorded`);
      assert.deepEqual(await readdir(root), [], `${why}: nothing is written`);
    }
  });

  it("installs nothing from a manifest that is not its row's", async () => {
    const sound = chunkedGame(soundGame());
    const cases: Array<[string, Partial<ChunkedBuild>, InstallFailure]> = [
      ["another manifest's checksum", { sha256: "0".repeat(64) }, InstallFailure.Network],
      ["a game larger than its row states", { installedBytes: sound.installedBytes - 1 }, InstallFailure.TooLarge],
      [
        "a game smaller than its row states",
        { installedBytes: sound.installedBytes + 1 },
        InstallFailure.UnsafeArchive,
      ],
      ["no such program", { entry: "Dust Runners/Other.x86_64" }, InstallFailure.EntryMissing],
      ["a link in the program's place", { entry: "Dust Runners/current" }, InstallFailure.EntryMissing],
      ["a folder off the build hosts", { chunksUrl: "https://evil.example/chunks/" }, InstallFailure.Network],
    ];
    for (const [why, overrides, failure] of cases) {
      const { install, root, store } = await rig({
        games: { [SLUG]: [rowOf(sound, overrides)] },
        objects: sound.objects,
      });
      assert.equal(await install(), failure, why);
      assert.deepEqual(await readdir(root), [], `${why}: nothing is written`);
      assert.ok(
        store.asked.every((url) => url.startsWith(folderOf(SLUG))),
        `${why}: only the build host is asked`,
      );
    }
    const swapped = new Map([[`${"0".repeat(64)}.manifest.json`, sound.manifestBytes]]);
    const other = await rig({ games: { [SLUG]: [rowOf(sound, { sha256: "0".repeat(64) })] }, objects: swapped });
    assert.equal(await other.install(), InstallFailure.Checksum, "another manifest under the row's name");
    assert.deepEqual(await readdir(other.root), []);
  });

  it("fails on each chunk that is not the manifest's, and writes none of it", async () => {
    const raw = Buffer.concat([elfX64(), noise(4096 - 64, 3)]);
    const game = chunkedGame([{ path: ENTRY, data: raw, exec: true }], raw.length);
    const name = `${game.manifest.chunks[0]?.hash}.bin`;
    const longer = storedChunk(Buffer.concat([raw, raw]), "raw");
    const answered: Array<[string, () => Response, InstallFailure]> = [
      ["an HTTP error", () => new Response("no", { status: 500 }), InstallFailure.Network],
      ["an answer longer than a chunk can be", () => new Response(new Uint8Array(longer)), InstallFailure.TooLarge],
      [
        "an answer cut short",
        () => new Response(new Uint8Array(raw.subarray(0, 100)), { headers: { "content-length": "4097" } }),
        InstallFailure.Network,
      ],
      [
        "a redirect off the build hosts",
        () => new Response(null, { status: 302, headers: { location: "https://evil.example/chunk.bin" } }),
        InstallFailure.Network,
      ],
    ];
    // A stored object longer than the chunk and its codec byte is never read whole, whatever it holds.
    const stored: Array<[string, () => Response, InstallFailure]> = hostileChunks(raw).map(([why, bytes, failure]) => [
      why,
      () => new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } }),
      bytes.length > raw.length + 1 ? InstallFailure.TooLarge : failure,
    ]);
    // A lost connection or a damaged answer is worth asking for again; a chunk that can never be right is not.
    const retried: ReadonlySet<InstallFailure> = new Set([InstallFailure.Network, InstallFailure.Checksum]);
    for (const [why, answer, failure] of [...stored, ...answered]) {
      const { install, installs, root, store } = await rig({
        games: { [SLUG]: [rowOf(game)] },
        objects: game.objects,
        answer: (asked) => (asked === name ? answer() : undefined),
      });
      assert.equal(await install(), failure, why);
      assert.equal(store.askedChunks().length, retried.has(failure) ? 3 : 1, `${why}: how often it is asked for`);
      assert.equal(await installs.record(SLUG), null, `${why}: not recorded`);
      assert.deepEqual(await readdir(root), [".downloads"], `${why}: no game folder`);
      const work = `${SLUG}-${game.sha256.slice(0, 16)}.chunked`;
      assert.deepEqual(await readdir(path.join(root, ".downloads")), [work], `${why}: only the work folder`);
      const laid = await readFile(path.join(root, ".downloads", work, "game", ENTRY));
      assert.deepEqual(laid, Buffer.alloc(raw.length), `${why}: none of its bytes are written`);
      assert.ok(
        store.asked.every((url) => url.startsWith(folderOf(SLUG))),
        `${why}: only the build host is asked`,
      );
    }
  });

  it("refuses a link that leaves the game through another link, as an unpacked zip's is", async () => {
    // Each link stays inside read as text; followed on disk, `a` climbs out through `d/e/b`.
    const items: ChunkItem[] = [
      { path: ENTRY, data: elfX64(), exec: true },
      { path: "Dust Runners/d/e/b", link: ".." },
      { path: "Dust Runners/a", link: "d/e/b/../../.." },
    ];
    const game = chunkedGame(items);
    const { install, installs, root } = await rig({ games: { [SLUG]: [rowOf(game)] }, objects: game.objects });
    assert.equal(await install(), InstallFailure.UnsafeArchive);
    assert.equal(await installs.record(SLUG), null);
    assert.deepEqual(await readdir(root), [".downloads"]);
    assert.deepEqual(await readdir(path.join(root, ".downloads")), []);
  });

  it("refuses another processor's program", async () => {
    const arm = elfX64();
    arm.writeUInt16LE(0xb7, 18);
    const game = chunkedGame([{ path: ENTRY, data: arm, exec: true }]);
    const { install, root } = await rig({ games: { [SLUG]: [rowOf(game)] }, objects: game.objects });
    assert.equal(await install(), InstallFailure.UnsupportedOs);
    assert.deepEqual(await readdir(path.join(root, SLUG)).catch(() => []), []);
  });
});

describe("Play's native installer with a chunked Windows build", () => {
  it("installs it: its program a PE image for this computer, the version folder its app", async () => {
    const entry = "Dust Runners/DustRunners.exe";
    const items: ChunkItem[] = [
      { path: entry, data: peImageBytes({ machine: PeMachine.X64 }) },
      { path: "Dust Runners/DustRunners_Data/level0", data: noise(300, 1) },
      { path: "Dust Runners/UnityPlayer.dll", data: noise(200, 2) },
    ];
    const game = chunkedGame(items, 128);
    const build = rowOf(game, { platform: NativePlatform.Windows, entry, minOs: "10.0.19041" });
    const { installs, install, root } = await rig({
      games: { [SLUG]: [build] },
      objects: game.objects,
      host: WINDOWS_PC,
    });
    assert.equal(await install(), null);
    const record = await installs.record(SLUG);
    assert.deepEqual(
      [record?.platform, record?.entry, record?.executable, record?.bundleName, record?.manifestSha256],
      [NativePlatform.Windows, ".", entry, "DustRunners", game.sha256],
    );
    assert.deepEqual(await installedFiles(path.join(root, SLUG, "1.0"), items), statedFiles(items));
    const arm = chunkedGame([{ path: entry, data: peImageBytes({ machine: PeMachine.Arm64 }) }]);
    const other = await rig({
      games: { [SLUG]: [rowOf(arm, { platform: NativePlatform.Windows, entry })] },
      objects: arm.objects,
      host: WINDOWS_PC,
    });
    assert.equal(await other.install(), InstallFailure.UnsupportedOs, "another processor's program");
  });
});

describe("Play's native installer with a chunked Mac build", { skip: MAC_SKIP }, () => {
  const APP = "Dust Runners.app";
  const LEVEL = `${APP}/Contents/Resources/level.dat`;
  const CHUNK_BYTES = 16 * 1024;
  const macRow = (game: ChunkedGame, version: string): ChunkedBuild =>
    rowOf(game, { platform: NativePlatform.Mac, arch: NativeArch.Universal, entry: APP, version });
  const bundleId = async (app: string) =>
    (
      await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", `${app}/Contents/Info.plist`])
    ).stdout.trim();

  it("makes the app Genex's as an unpacked zip's is, and an update downloads again what that changed", async () => {
    const made = await tmpDir("native-chunk-app-");
    const level = noise(256 * 1024, 11);
    await makeApp(path.join(made, "v1"), "Dust Runners", { resources: { "level.dat": level, "notes.txt": "one" } });
    await makeApp(path.join(made, "v2"), "Dust Runners", { resources: { "level.dat": level, "notes.txt": "two" } });
    const v1 = chunkedGame(await itemsOf(path.join(made, "v1")), CHUNK_BYTES);
    const v2 = chunkedGame(await itemsOf(path.join(made, "v2")), CHUNK_BYTES);
    const games = { [SLUG]: [macRow(v1, "1.0")] };
    const objects = new Map([...v1.objects, ...v2.objects]);
    const { installs, install, root, store } = await rig({ games, objects, host: THIS_MAC });
    assert.equal(await install(), null);
    const first = path.join(root, SLUG, "1.0", APP);
    assert.equal(await bundleId(first), `${GAME_BUNDLE_PREFIX}${SLUG}`, "never another app's id");
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", first]);
    assert.equal((await installs.record(SLUG))?.executable, "Contents/MacOS/Game");
    assert.deepEqual(await readFile(path.join(root, SLUG, KEPT_MANIFEST)), v1.manifestBytes);

    games[SLUG] = [macRow(v2, "1.1")];
    store.asked.length = 0;
    assert.equal(await install(), null);
    const asked = new Set(store.askedChunks());
    const manifest = parseManifest(v2.manifestBytes);
    const file = manifest.stream.find((one) => one.path === LEVEL);
    assert.ok(file);
    const inside = manifest.chunks.filter(
      (chunk) => chunk.offset >= file.offset && chunk.offset + chunk.size <= file.offset + file.size,
    );
    assert.ok(inside.length >= 14, "the level file spans many whole chunks");
    assert.deepEqual(
      inside.filter((chunk) => asked.has(chunk.hash)),
      [],
      "a file signing left alone gives its chunks to the update",
    );
    // The first chunk holds Info.plist and the program's start, the same in both versions as
    // published. Genex rewrote the installed Info.plist (the bundle id), so it is no source for it.
    const head = manifest.chunks[0]?.hash ?? "";
    assert.ok(
      v1.manifest.chunks.some((chunk) => chunk.hash === head),
      "the installed version was published with it",
    );
    assert.ok(asked.has(head), "what Genex changed after installing is downloaded, not trusted");
    assert.ok(asked.size < manifest.chunks.length, "and the rest is not");
    const second = path.join(root, SLUG, "1.1", APP);
    assert.equal(await bundleId(second), `${GAME_BUNDLE_PREFIX}${SLUG}`);
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", second]);
    assert.deepEqual(await readFile(path.join(second, "Contents/Resources/level.dat")), level);
    assert.equal(await readFile(path.join(second, "Contents/Resources/notes.txt"), "utf8"), "two");
    assert.deepEqual((await readdir(path.join(root, SLUG))).sort(), [KEPT_MANIFEST, "1.1", SAVES]);
  });

  it("refuses an app that is not signed, and one the row does not name", async () => {
    const made = await tmpDir("native-chunk-app-");
    await makeApp(path.join(made, "unsigned"), "Dust Runners", { unsigned: true });
    const unsigned = chunkedGame(await itemsOf(path.join(made, "unsigned")), CHUNK_BYTES);
    const first = await rig({
      games: { [SLUG]: [macRow(unsigned, "1.0")] },
      objects: unsigned.objects,
      host: THIS_MAC,
    });
    assert.equal(await first.install(), InstallFailure.Unsigned);
    assert.deepEqual(await readdir(path.join(first.root, SLUG)).catch(() => []), [], "no version folder");
    const other = { ...macRow(unsigned, "1.0"), entry: "Other.app" };
    const second = await rig({ games: { [SLUG]: [other] }, objects: unsigned.objects, host: THIS_MAC });
    assert.equal(await second.install(), InstallFailure.EntryMissing);
    assert.deepEqual(await readdir(second.root), [], "nothing is written");
  });
});
