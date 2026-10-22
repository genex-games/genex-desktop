/**
 * Play's native installer with a Linux build: the archive unpacked by the app itself, the program
 * the build names checked as an ELF binary for this computer's processor and made runnable, and
 * the whole version folder recorded as the game's app. Anything off (no such program, a link in
 * its place, another processor's binary, a link out of the game) leaves no game behind.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { type InstallOutcome, nativeInstalls, SAVES } from "../../src/main/play/native-installs.ts";
import { GAME_BUNDLE_PREFIX, runTool } from "../../src/main/play/native-unpack.ts";
import type { PlayGameDetail } from "../../src/shared/play.ts";
import {
  InstallFailure,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  NativePlatform,
} from "../../src/shared/play-native.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { writeZip, type ZipItem } from "../helpers/zip-writer.ts";

const SKIP = process.platform === "win32" ? "a Linux build's links and execute bits need a unix disk" : false;
const HOST = "builds.example.test";
const THIS_PC: NativeHost = { platform: NativePlatform.Linux, arch: NativeArch.X64, osVersion: "6.8.0" };
const GB = 1024 ** 3;
const ELF_X64 = 0x3e;
const ELF_ARM64 = 0xb7;
/** A program's unix mode without its execute bits: what a build packed on Windows carries. */
const NOT_RUNNABLE = 0o100644;

/** A 64-bit little-endian ELF program's header for `machine`. */
function elf(machine: number): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

/** A Unity-style Linux build: the player beside its data, as `genex native publish` zips it. */
const unityBuild = (program: ZipItem["data"] = elf(ELF_X64), mode = NOT_RUNNABLE): ZipItem[] => [
  { name: "Dust Runners/" },
  { name: "Dust Runners/Dust.x86_64", data: program, mode },
  { name: "Dust Runners/UnityPlayer.so", data: elf(ELF_X64), deflate: true },
  { name: "Dust Runners/Dust_Data/level0", data: "level", deflate: true },
];

/** A catalog row for `archive`. */
const buildOf = (archive: Buffer, overrides: Partial<NativeBuild> = {}): NativeBuild => ({
  platform: NativePlatform.Linux,
  arch: NativeArch.X64,
  version: "1.0",
  sizeBytes: archive.length,
  installedBytes: archive.length * 4 + 1024 ** 2,
  sha256: createHash("sha256").update(archive).digest("hex"),
  url: `https://${HOST}/dust-runners/1.0/linux.zip`,
  entry: "Dust Runners/Dust.x86_64",
  publishedAt: "2026-10-22T00:00:00.000Z",
  ...overrides,
});

/** A game's page with `build`, as the catalog answers it. */
const page = (slug: string, build: NativeBuild): PlayGameDetail => ({
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
  native: { web: false, engine: "unity", builds: [build] },
  likes: 0,
  liked: false,
  comments: 0,
  shots: [],
  updatedAt: null,
});

/** Install `items` zipped as a build (with `overrides`) into a fresh folder; its outcome and folder. */
async function install(items: readonly ZipItem[], overrides: Partial<NativeBuild> = {}) {
  const archive = writeZip(items);
  const build = buildOf(archive, overrides);
  const root = path.join(await realpath(await tmpDir("native-linux-")), "installed-games");
  const outcomes: InstallOutcome[] = [];
  const installs = nativeInstalls({
    root,
    host: THIS_PC,
    hosts: new Set([HOST]),
    game: async (slug) => page(slug, build),
    fetch: (async () =>
      new Response(new Uint8Array(archive), { headers: { "content-length": String(archive.length) } })) as typeof fetch,
    run: runTool,
    freeBytes: async () => 100 * GB,
    now: Date.now,
    publish: () => {},
    outcome: (outcome) => outcomes.push(outcome),
  });
  await installs.install("dust-runners");
  await installs.idle();
  return { installs, root, failure: outcomes[0]?.failure };
}

describe("Play's native installer on Linux", { skip: SKIP }, () => {
  it("installs a Linux build: its program runnable, the version folder its app", async () => {
    const { installs, root, failure } = await install(unityBuild());
    assert.equal(failure, null);
    const record = await installs.record("dust-runners");
    assert.deepEqual(
      [record?.platform, record?.entry, record?.executable, record?.bundleId, record?.windowed],
      [NativePlatform.Linux, ".", "Dust Runners/Dust.x86_64", `${GAME_BUNDLE_PREFIX}dust-runners`, false],
    );
    const version = path.join(root, "dust-runners", "1.0");
    assert.equal(await installs.appOf("dust-runners"), version);
    const program = await lstat(path.join(version, "Dust Runners", "Dust.x86_64"));
    assert.equal(program.mode & 0o111, 0o111, "a build packed without execute bits still runs");
    assert.deepEqual((await readdir(path.join(root, "dust-runners"))).sort(), ["1.0", SAVES]);
    assert.deepEqual(await readdir(path.join(version, "Dust Runners", "Dust_Data")), ["level0"]);
  });

  it("refuses each build it cannot run, and keeps no game", async () => {
    const cases: Array<[string, ZipItem[], Partial<NativeBuild>, InstallFailure]> = [
      ["no such program", unityBuild(), { entry: "Dust Runners/Other.x86_64" }, InstallFailure.EntryMissing],
      [
        "a link in the program's place",
        [
          { name: "Dust Runners/real.x86_64", data: elf(ELF_X64), mode: 0o100755 },
          { name: "Dust Runners/Dust.x86_64", link: "real.x86_64" },
        ],
        {},
        InstallFailure.EntryMissing,
      ],
      ["a folder in the program's place", [{ name: "Dust Runners/Dust.x86_64/" }], {}, InstallFailure.EntryMissing],
      ["another processor's program", unityBuild(elf(ELF_ARM64)), {}, InstallFailure.UnsupportedOs],
      ["a program that is no ELF binary", unityBuild("#!/bin/sh\necho hi\n"), {}, InstallFailure.UnsupportedOs],
      [
        "a link out of the game",
        [...unityBuild(), { name: "Dust Runners/home", link: "../../.." }],
        {},
        InstallFailure.UnsafeArchive,
      ],
      ["an entry climbing out", [...unityBuild(), { name: "../evil", data: "x" }], {}, InstallFailure.UnsafeArchive],
    ];
    for (const [why, items, overrides, expected] of cases) {
      const { installs, root, failure } = await install(items, overrides);
      assert.equal(failure, expected, why);
      assert.equal(await installs.record("dust-runners"), null, `${why}: not recorded`);
      const left = (await readdir(root)).filter((name) => name !== "index.json" && name !== ".downloads");
      assert.deepEqual(left, [], `${why}: no game folder left`);
    }
  });
});
