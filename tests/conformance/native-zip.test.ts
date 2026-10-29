/**
 * A native build's zip is read from its central directory before anything is unpacked. Every entry
 * is hostile: one that would land outside the game, a link out of it, a file written through a
 * link, a device or more bytes than the catalog states is refused, and nothing is written. A Linux
 * build is unpacked by the app itself: what it writes keeps its links and execute bits, and an
 * entry with more bytes than its record states is refused.
 */
import assert from "node:assert/strict";
import { lstat, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { listZip, unpackZip, ZipEntryKind, ZipError, ZipRefusal } from "../../src/main/play/native-zip.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { writeZip, type ZipItem } from "../helpers/zip-writer.ts";

const BIG = 1024 ** 3;

/** An app bundle's entries as `ditto -c -k --keepParent` writes them, with a framework's links. */
const BUNDLE: ZipItem[] = [
  { name: "Dust Runners.app/" },
  { name: "Dust Runners.app/Contents/" },
  { name: "Dust Runners.app/Contents/Info.plist", data: "<plist/>" },
  { name: "Dust Runners.app/Contents/MacOS/Dust Runners", data: "binary" },
  { name: "Dust Runners.app/Contents/Frameworks/Engine.framework/Versions/A/Engine", data: "lib", deflate: true },
  { name: "Dust Runners.app/Contents/Frameworks/Engine.framework/Versions/Current", link: "A" },
  { name: "Dust Runners.app/Contents/Frameworks/Engine.framework/Engine", link: "Versions/Current/Engine" },
];

async function archive(items: readonly ZipItem[], options: { zip64?: boolean } = {}) {
  const dir = await tmpDir("native-zip-");
  const file = path.join(dir, "game.zip");
  await writeFile(file, writeZip(items, options));
  return { dir, file };
}

/** Entries a zip may hold that would land outside the game, each with why. */
const HOSTILE: Array<[string, ZipItem[]]> = [
  ["a climb out", [{ name: "../evil.sh", data: "x" }]],
  ["a climb from inside", [{ name: "Game.app/../../evil.sh", data: "x" }]],
  ["an absolute path", [{ name: "/etc/evil", data: "x" }]],
  ["a backslash", [{ name: "Game.app\\..\\evil", data: "x" }]],
  ["a drive", [{ name: "C:/evil", data: "x" }]],
  ["a control character", [{ name: "Game.app/a\nb", data: "x" }]],
  ["a dot segment", [{ name: "Game.app/./x", data: "x" }]],
  ["a link to an absolute path", [{ name: "Game.app/home", link: "/Users" }]],
  ["a link climbing out", [{ name: "Game.app/up", link: "../.." }]],
  ["a deflated link climbing out", [{ name: "Game.app/up", link: "../../../etc", deflate: true }]],
  [
    "a file written through a link",
    [
      { name: "Game.app/dir", link: "Contents" },
      { name: "Game.app/dir/evil", data: "x" },
    ],
  ],
  ["a device", [{ name: "Game.app/disk", data: "", mode: 0o060644 }]],
  ["a pipe", [{ name: "Game.app/pipe", data: "", mode: 0o010644 }]],
];

const refusal = (expected: ZipRefusal) => (error: unknown) => error instanceof ZipError && error.refusal === expected;

describe("a native build's zip", () => {
  it("lists an app bundle with its framework links, each with its kind, size and target", async () => {
    const { file } = await archive(BUNDLE);
    const listing = await listZip(file, BIG);
    assert.deepEqual(
      listing.entries.map((entry) => [entry.name, entry.kind, entry.target]),
      [
        ["Dust Runners.app", ZipEntryKind.Directory, null],
        ["Dust Runners.app/Contents", ZipEntryKind.Directory, null],
        ["Dust Runners.app/Contents/Info.plist", ZipEntryKind.File, null],
        ["Dust Runners.app/Contents/MacOS/Dust Runners", ZipEntryKind.File, null],
        ["Dust Runners.app/Contents/Frameworks/Engine.framework/Versions/A/Engine", ZipEntryKind.File, null],
        ["Dust Runners.app/Contents/Frameworks/Engine.framework/Versions/Current", ZipEntryKind.Link, "A"],
        ["Dust Runners.app/Contents/Frameworks/Engine.framework/Engine", ZipEntryKind.Link, "Versions/Current/Engine"],
      ],
    );
    assert.equal(listing.unpackedBytes, "<plist/>".length + "binary".length + "lib".length + 1 + 23);
  });

  it("reads the ZIP64 end records and sizes a large game's archive carries", async () => {
    const { file } = await archive(BUNDLE, { zip64: true });
    const listing = await listZip(file, BIG);
    assert.equal(listing.entries.length, BUNDLE.length);
    assert.equal(listing.entries[5]?.target, "A");
  });

  it("refuses each hostile entry and writes nothing", async () => {
    for (const [why, items] of HOSTILE) {
      const { dir, file } = await archive(items);
      await assert.rejects(listZip(file, BIG), refusal(ZipRefusal.Unsafe), why);
      assert.deepEqual(await readdir(dir), ["game.zip"], `${why}: nothing written`);
    }
  });

  it("refuses an archive that unpacks to more than the catalog states", async () => {
    const { file } = await archive([{ name: "Game.app/Contents/big", data: "x".repeat(4096), deflate: true }]);
    await assert.rejects(listZip(file, 4095), refusal(ZipRefusal.TooLarge));
    assert.equal((await listZip(file, 4096)).unpackedBytes, 4096);
  });

  it("refuses a file that is no zip, or one cut short", async () => {
    const dir = await tmpDir("native-zip-");
    const notZip = path.join(dir, "not.zip");
    await writeFile(notZip, "this is not a zip archive at all, just text that goes on for a while");
    await assert.rejects(listZip(notZip, BIG), refusal(ZipRefusal.Unreadable));
    const whole = writeZip(BUNDLE);
    const cut = path.join(dir, "cut.zip");
    await writeFile(cut, whole.subarray(0, whole.length - 30));
    await assert.rejects(listZip(cut, BIG), refusal(ZipRefusal.Unreadable));
  });

  it("unpacks a Linux build with its links and execute bits, deflated or stored", async () => {
    const items: ZipItem[] = [
      { name: "Dust/" },
      { name: "Dust/Dust.x86_64", data: "program", mode: 0o100755 },
      { name: "Dust/Dust_Data/level.bin", data: "x".repeat(5000), deflate: true },
      { name: "Dust/Dust_Data/empty", data: "" },
      { name: "Dust/libgame.so", link: "Dust_Data/level.bin" },
    ];
    for (const zip64 of [false, true]) {
      const { dir, file } = await archive(items, { zip64 });
      const into = path.join(dir, "game");
      const listing = await unpackZip(file, into, BIG);
      assert.equal(listing.entries.length, items.length);
      assert.equal(((await lstat(path.join(into, "Dust/Dust.x86_64"))).mode & 0o777).toString(8), "755");
      assert.equal(((await lstat(path.join(into, "Dust/Dust_Data/level.bin"))).mode & 0o111).toString(8), "0");
      assert.equal(await readFile(path.join(into, "Dust/Dust_Data/level.bin"), "utf8"), "x".repeat(5000));
      assert.equal(await readFile(path.join(into, "Dust/Dust_Data/empty"), "utf8"), "");
      assert.equal(await readlink(path.join(into, "Dust/libgame.so")), "Dust_Data/level.bin");
    }
  });

  it("unpacks nothing of a hostile archive", async () => {
    for (const [why, items] of HOSTILE) {
      const { dir, file } = await archive(items);
      await assert.rejects(unpackZip(file, path.join(dir, "game"), BIG), refusal(ZipRefusal.Unsafe), why);
      assert.deepEqual(await readdir(dir), ["game.zip"], `${why}: nothing written`);
    }
  });

  it("refuses an entry with more bytes than its record states, and an archive larger than allowed", async () => {
    const lying = await archive([{ name: "Dust/big", data: "x".repeat(4096), deflate: true, statedSize: 16 }]);
    await assert.rejects(unpackZip(lying.file, path.join(lying.dir, "game"), BIG), refusal(ZipRefusal.TooLarge));
    const large = await archive([{ name: "Dust/big", data: "x".repeat(4096) }]);
    await assert.rejects(unpackZip(large.file, path.join(large.dir, "game"), 4095), refusal(ZipRefusal.TooLarge));
    assert.deepEqual(await readdir(large.dir), ["game.zip"]);
  });
});
