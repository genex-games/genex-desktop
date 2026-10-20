/**
 * The one containment helper (src/substrate/paths.ts) that the host's path checks go through:
 * lexical `isInside`/`isBelow`, the shape check for an untrusted relative path, and the realpath
 * check that follows links. Hostile inputs first; a refused path touches nothing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertRelativePath,
  containedReal,
  isBelow,
  isInside,
  relativizeWorkspace,
  samePath,
  toPosixRelative,
} from "../../src/substrate/paths.ts";
import { sessionFileResolver } from "../../src/substrate/engines/local-session-tools.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";

describe("isInside and isBelow: lexical containment", () => {
  const table: Array<[root: string, target: string, inside: boolean, below: boolean, why: string]> = [
    ["/games/pond", "/games/pond", true, false, "the root itself is inside, not below"],
    ["/games/pond", "/games/pond/src/main.js", true, true, "a file under it"],
    ["/games/pond", "/games/pondering", false, false, "a sibling that shares the prefix"],
    ["/games/pond", "/games/pond-2/x", false, false, "a sibling with a dash"],
    ["/games/pond", "/games", false, false, "the parent"],
    ["/games/pond", "/games/pond/../rift", false, false, "a `..` that climbs out is resolved first"],
    ["/games/pond", "/games/pond/a/../../pond/b", true, true, "a `..` that comes back in"],
    ["/games/pond/", "/games/pond/b", true, true, "a trailing separator on the root"],
    ["/games/pond", "/games/pond/..hidden", true, true, "a name that merely starts with two dots"],
    ["/", "/etc/passwd", false, false, "the filesystem root contains only itself (fails closed)"],
    ["/", "/", true, false, "…and itself"],
  ];
  for (const [root, target, inside, below, why] of table) {
    it(`${why}: ${root} ⊇ ${target}`, () => {
      assert.equal(isInside(root, target), inside);
      assert.equal(isBelow(root, target), below);
    });
  }
  it("resolves relative paths against the same working folder on both sides", () => {
    assert.equal(isInside("games", "games/pond"), true);
    assert.equal(isInside("games", path.join(process.cwd(), "games", "pond")), true);
    assert.equal(isInside("games", "other/pond"), false);
  });
});

describe("isInside, isBelow and samePath on Windows: names are case-blind, as NTFS reads them", () => {
  const windows = StudioPlatform.Windows;
  const table: Array<[root: string, target: string, inside: boolean, below: boolean, why: string]> = [
    [
      String.raw`C:\Users\Dima\AI Games\rift`,
      String.raw`c:\users\dima\ai games\rift\src\a.js`,
      true,
      true,
      "another case",
    ],
    [String.raw`c:\Users\Dima`, String.raw`C:\Users\Dima`, true, false, "the drive letter's case"],
    [String.raw`C:\Users\Dima`, "C:/Users/Dima/a.js", true, true, "forward slashes"],
    [String.raw`C:\Users\Dima`, String.raw`c:\users\dimaX\a.js`, false, false, "a sibling that shares the prefix"],
    [String.raw`C:\Users\Dima`, String.raw`D:\Users\Dima\a.js`, false, false, "another drive"],
    [String.raw`C:\Users\Dima`, String.raw`c:\users\dima\..\eve\a.js`, false, false, "a `..` that climbs out"],
  ];
  for (const [root, target, inside, below, why] of table) {
    it(`${why}: ${root} ⊇ ${target}`, () => {
      assert.equal(isInside(root, target, windows), inside);
      assert.equal(isBelow(root, target, windows), below);
    });
  }
  it("samePath ignores case and separators on Windows, and only there", () => {
    assert.equal(samePath("C:\\Users\\Dima\\", "c:/users/dima", windows), true);
    assert.equal(samePath(String.raw`C:\Users\Dima`, String.raw`C:\Users\Eve`, windows), false);
    assert.equal(samePath("/Users/Dima", "/users/dima", StudioPlatform.Mac), false);
    assert.equal(isInside("/games/Pond", "/games/pond/a.js", StudioPlatform.Mac), false);
  });
  it("a session writes through a differently cased spelling of its own workspace", {
    skip: process.platform !== "win32" && "the file system is case-sensitive here",
  }, async () => {
    const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "paths-case-")));
    try {
      writeFileSync(path.join(dir, "a.js"), "x");
      const resolve = sessionFileResolver({
        cwd: dir,
        readRoots: [dir],
        forbidden: [path.join(dir, "secret")],
        deniedWrites: [],
        readonly: false,
        ownership: undefined,
      });
      assert.equal(await resolve(path.join(dir.toLowerCase(), "a.js"), true), path.join(dir, "a.js"));
      await assert.rejects(resolve(path.join(dir.toUpperCase(), "SECRET", "b.js"), true));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertRelativePath: the shape of a path an untrusted writer names", () => {
  const refused = [
    "",
    "/etc/passwd",
    "../x",
    "a/../../x",
    "a/./b",
    "./a",
    "a//b",
    "a/",
    "a\\b",
    "a\0b",
    "a\nb",
    "..",
    ".",
  ];
  for (const bad of refused) {
    it(`refuses ${JSON.stringify(bad)}`, () => assert.throws(() => assertRelativePath(bad), /Invalid plugin path/));
  }
  it("refuses what is not a string at all", () => {
    for (const bad of [null, undefined, 3, {}, ["a"]])
      assert.throws(() => assertRelativePath(bad as unknown as string), /Invalid plugin path/);
  });
  it("returns an ordinary relative path unchanged, dotted names included", () => {
    for (const good of ["a", "assets/models/ship.glb", ".well-known/x", "a/..b", "a b/c"])
      assert.equal(assertRelativePath(good), good);
  });
});

describe("containedReal: a relative path resolved through links, strictly under the real root", () => {
  function tree(t: { after(fn: () => void): void }) {
    // The native realpath, as containedReal uses: on Windows it also expands 8.3 short names (RUNNER~1).
    const top = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "paths-")));
    t.after(() => rmSync(top, { recursive: true, force: true }));
    const root = path.join(top, "game");
    mkdirSync(path.join(root, "assets"), { recursive: true });
    writeFileSync(path.join(root, "assets", "ship.glb"), "glb");
    writeFileSync(path.join(top, "secret.txt"), "secret");
    symlinkSync(path.join(top, "secret.txt"), path.join(root, "assets", "leak.txt"));
    symlinkSync(top, path.join(root, "up"));
    symlinkSync(path.join(root, "assets", "ship.glb"), path.join(root, "alias.glb"));
    symlinkSync(path.join(top, "missing"), path.join(root, "dangling"));
    // The root reached through a link of its own resolves to the same real root.
    symlinkSync(root, path.join(top, "game-link"));
    return { top, root };
  }

  it("answers the real path of a file inside, also through a link that stays inside", async (t) => {
    const { root, top } = tree(t);
    assert.equal(await containedReal(root, "assets/ship.glb"), path.join(root, "assets", "ship.glb"));
    assert.equal(await containedReal(root, "alias.glb"), path.join(root, "assets", "ship.glb"));
    assert.equal(
      await containedReal(path.join(top, "game-link"), "assets/ship.glb"),
      path.join(root, "assets", "ship.glb"),
    );
  });

  it("refuses a link out of the root, a folder link out, and a malformed path, without creating anything", async (t) => {
    const { root, top } = tree(t);
    const before = readdirSync(top).sort();
    await assert.rejects(containedReal(root, "assets/leak.txt"), /Path escapes authorized root/);
    await assert.rejects(containedReal(root, "up/secret.txt"), /Path escapes authorized root/);
    await assert.rejects(containedReal(root, "../secret.txt"), /Invalid plugin path/);
    await assert.rejects(containedReal(root, path.join(top, "secret.txt")), /Invalid plugin path/);
    await assert.rejects(containedReal(root, "dangling"), { code: "ENOENT" });
    await assert.rejects(containedReal(root, "assets/none.glb"), { code: "ENOENT" });
    await assert.rejects(containedReal(path.join(top, "no-root"), "a"), { code: "ENOENT" });
    assert.deepEqual(readdirSync(top).sort(), before, "a refused path creates nothing");
  });
});

describe("relativizeWorkspace: tool inputs read relative to the workspace", () => {
  it("strips a POSIX workspace from paths and commands, and names the workspace itself '.'", () => {
    const cwd = "/Users/ada/AI Games/hi";
    assert.equal(relativizeWorkspace(`${cwd}/src/a.js`, cwd, "darwin"), "src/a.js");
    assert.equal(
      relativizeWorkspace(`cd "${cwd}" && node ${cwd}/src/main.js`, `${cwd}/`, "darwin"),
      'cd "." && node src/main.js',
    );
    assert.equal(
      relativizeWorkspace(`${cwd}\\odd`, cwd, "darwin"),
      ".\\odd",
      "a backslash is a file name character there",
    );
  });
  it("on Windows strips the workspace in either slash spelling and before either separator", () => {
    const cwd = "C:\\Users\\Ada\\AI Games\\hi";
    assert.equal(relativizeWorkspace(`${cwd}\\src\\a.js`, cwd, "win32"), "src\\a.js");
    assert.equal(relativizeWorkspace("C:/Users/Ada/AI Games/hi/src/a.js", cwd, "win32"), "src/a.js");
    assert.equal(relativizeWorkspace(`cd /d "${cwd}"`, `${cwd}\\`, "win32"), 'cd /d "."');
    assert.equal(relativizeWorkspace("/tmp/ws/src/a.js", "/tmp/ws", "win32"), "src/a.js");
  });
});

describe("toPosixRelative: a relative path as the rules and the wire read it", () => {
  it("turns Windows separators into slashes, and leaves a backslash in a POSIX file name alone", () => {
    assert.equal(toPosixRelative("src\\enemies\\boss.js", "win32"), "src/enemies/boss.js");
    assert.equal(toPosixRelative("..\\up", "win32"), "../up");
    assert.equal(toPosixRelative("src/a.js", "win32"), "src/a.js");
    assert.equal(toPosixRelative("odd\\name.js", "darwin"), "odd\\name.js");
    assert.equal(toPosixRelative(path.relative(path.resolve("a"), path.resolve("a", "b", "c"))), "b/c");
  });
});
