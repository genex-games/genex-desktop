/**
 * Builds keyed by content (`src/main/rust-build-content.ts`, lane PW): which checkouts are clean
 * enough to be named by their commit's tree, when a stage holds exactly that tree, and the lane's
 * records of content keys, read only from real build folders under its root. Every hostile record
 * is no record, and reading changes nothing on disk.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  CONTENT_RECORD_SUFFIX,
  cleanTreeOf,
  contentKeyOf,
  type ContentFacts,
  RustContentIndex,
  stageMatchesTree,
} from "../../src/main/rust-build-content.ts";
import { tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];
const SKIP_ON_WINDOWS = process.platform === "win32" ? "links need privileges on Windows" : false;

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", dir, ...IDENTITY, ...args])).stdout.trim();
}

/** A committed game: sources, an asset and an ignore file for its build folders. */
async function committedGame(parent: string): Promise<string> {
  const dir = path.join(parent, "game");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
  await writeFile(path.join(dir, "assets", "fish.txt"), "fish");
  await writeFile(path.join(dir, ".gitignore"), "target/\nassets/*.cache\n");
  await git(dir, "init", "-q");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "game");
  return await realpath(dir);
}

const FACTS: ContentFacts = {
  tree: "a".repeat(40),
  lock: "b".repeat(64),
  target: "macos",
  triple: "aarch64-apple-darwin",
  profile: "dev",
  flavour: "dev",
  net: "loopback",
  trusted: false,
  ejectedFrom: null,
  grant: { names: [], crates: [] },
  sdk: null,
};

/** Every path under `dir` with its bytes or link target: what "nothing changed" compares. */
async function snapshot(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(`${full}:${await readFile(full, "utf8")}`);
      else out.push(`${full}:link`);
    }
  };
  await walk(dir);
  return out.sort().join("\n");
}

describe("which checkouts a build may be named by their commit's tree", () => {
  it("a clean checkout is its HEAD's tree; ignored build folders leave it clean", async () => {
    const parent = await realpath(await tmpDir("content-clean-"));
    const game = await committedGame(parent);
    await mkdir(path.join(game, "target"), { recursive: true });
    await writeFile(path.join(game, "target", "junk"), "x");
    assert.equal(await cleanTreeOf(game), await git(game, "rev-parse", "HEAD^{tree}"));
  });

  const UNCLEAN = [
    {
      name: "an edited source",
      change: (game: string) => writeFile(path.join(game, "src", "main.rs"), "fn main() { }\n"),
    },
    { name: "an untracked asset", change: (game: string) => writeFile(path.join(game, "assets", "new.txt"), "new") },
    {
      name: "an ignored file in a staged folder",
      change: (game: string) => writeFile(path.join(game, "assets", "a.cache"), "c"),
    },
    {
      name: "a staged but uncommitted change",
      change: async (game: string) => {
        await writeFile(path.join(game, "assets", "fish.txt"), "trout");
        await git(game, "add", "-A");
      },
    },
  ] as const;
  for (const row of UNCLEAN) {
    it(`a checkout with ${row.name} has no tree`, async () => {
      const parent = await realpath(await tmpDir("content-unclean-"));
      const game = await committedGame(parent);
      await row.change(game);
      assert.equal(await cleanTreeOf(game), null);
    });
  }

  it("a folder inside another repository, and a folder git does not know, have no tree", async () => {
    const parent = await realpath(await tmpDir("content-nested-"));
    const game = await committedGame(parent);
    assert.equal(await cleanTreeOf(path.join(game, "src")), null);
    const plain = path.join(parent, "plain");
    await mkdir(plain);
    assert.equal(await cleanTreeOf(plain), null);
  });

  it("a key changes with every fact a build is made of", () => {
    const base = contentKeyOf(FACTS);
    assert.match(base, /^[0-9a-f]{64}$/);
    for (const [name, value] of Object.entries({
      tree: "c".repeat(40),
      lock: "d".repeat(64),
      trusted: true,
      sdk: "/sdk",
    }))
      assert.notEqual(contentKeyOf({ ...FACTS, [name]: value }), base, name);
  });
});

describe("whether a stage holds exactly the tree", () => {
  async function staged(parent: string, game: string): Promise<string> {
    const stage = path.join(parent, "stage");
    await mkdir(path.join(stage, "src"), { recursive: true });
    await mkdir(path.join(stage, "assets"), { recursive: true });
    await writeFile(path.join(stage, "src", "main.rs"), await readFile(path.join(game, "src", "main.rs")));
    await writeFile(path.join(stage, "assets", "fish.txt"), await readFile(path.join(game, "assets", "fish.txt")));
    await writeFile(path.join(stage, "Cargo.toml"), "[package]\n");
    return stage;
  }
  const hostWritten = (rel: string) => rel === "Cargo.toml";

  it("matches a stage of the tree's files beside the host's manifest", async () => {
    const parent = await realpath(await tmpDir("content-stage-"));
    const game = await committedGame(parent);
    const tree = await git(game, "rev-parse", "HEAD^{tree}");
    assert.equal(await stageMatchesTree(await staged(parent, game), game, tree, hostWritten), true);
  });

  const MISMATCHES = [
    { name: "a changed byte", change: (stage: string) => writeFile(path.join(stage, "assets", "fish.txt"), "fisH") },
    { name: "a file the tree lacks", change: (stage: string) => writeFile(path.join(stage, "src", "extra.rs"), "") },
    { name: "a link", change: (stage: string) => symlink("/etc/hosts", path.join(stage, "assets", "hosts")) },
  ] as const;
  for (const row of MISMATCHES) {
    it(`refuses a stage with ${row.name}`, { skip: SKIP_ON_WINDOWS }, async () => {
      const parent = await realpath(await tmpDir("content-stage-bad-"));
      const game = await committedGame(parent);
      const stage = await staged(parent, game);
      await row.change(stage);
      const tree = await git(game, "rev-parse", "HEAD^{tree}");
      assert.equal(await stageMatchesTree(stage, game, tree, hostWritten), false);
    });
  }

  it("refuses a tree name that is not an object name, running no git with it", async () => {
    const parent = await realpath(await tmpDir("content-stage-name-"));
    const game = await committedGame(parent);
    for (const tree of ["--output=/tmp/x", "HEAD", "../x", ""])
      assert.equal(await stageMatchesTree(await staged(parent, game), game, tree, hostWritten), false, tree);
  });
});

describe("the lane's records of content keys", () => {
  const KEY = "e".repeat(64);
  const record = (fields: Record<string, unknown>) =>
    `${JSON.stringify({ version: 1, key: KEY, linted: true, ...fields })}\n`;

  it("records a build and finds it, newest first, with whether clippy gated it", async () => {
    const root = await realpath(await tmpDir("content-index-"));
    const index = new RustContentIndex(root);
    const older = path.join(root, `game-${"1".repeat(12)}`, "macos-000000000000");
    const newer = path.join(root, `game-${"2".repeat(12)}`, "macos-000000000000");
    for (const bin of [older, newer]) await mkdir(path.dirname(bin), { recursive: true });
    await index.record(older, KEY, true, 1);
    await index.record(newer, KEY, false, 2);
    assert.deepEqual(
      (await index.recorded(KEY)).map((found) => [found.bin, found.linted]),
      [
        [newer, false],
        [older, true],
      ],
    );
    const reread = await new RustContentIndex(root).recorded(KEY);
    assert.deepEqual(reread.map((found) => found.bin).sort(), [newer, older].sort(), "read back from disk");
  });

  /** A hostile `<bin>.content` (or what holds it) under the lane's root: never a record. */
  const HOSTILE = [
    {
      name: "malformed JSON",
      plant: (project: string) => writeFile(path.join(project, `macos-x${CONTENT_RECORD_SUFFIX}`), "{"),
    },
    {
      name: "another version",
      plant: (project: string) =>
        writeFile(path.join(project, `macos-x${CONTENT_RECORD_SUFFIX}`), record({ version: 2 })),
    },
    {
      name: "a key that is no digest",
      plant: (project: string) =>
        writeFile(path.join(project, `macos-x${CONTENT_RECORD_SUFFIX}`), record({ key: "../../etc" })),
    },
    {
      name: "no lint answer",
      plant: (project: string) =>
        writeFile(path.join(project, `macos-x${CONTENT_RECORD_SUFFIX}`), record({ linted: "yes" })),
    },
    {
      name: "a folder in its place",
      plant: (project: string) => mkdir(path.join(project, `macos-x${CONTENT_RECORD_SUFFIX}`)),
    },
    {
      name: "a link to a record elsewhere",
      plant: async (project: string, outside: string) => {
        await writeFile(path.join(outside, "record"), record({}));
        await symlink(path.join(outside, "record"), path.join(project, `macos-x${CONTENT_RECORD_SUFFIX}`));
      },
    },
  ] as const;
  for (const row of HOSTILE) {
    it(`reads ${row.name} as no record, and changes nothing`, { skip: SKIP_ON_WINDOWS }, async () => {
      const parent = await realpath(await tmpDir("content-hostile-"));
      const root = path.join(parent, "rust-builds");
      const outside = path.join(parent, "outside");
      const project = path.join(root, `game-${"3".repeat(12)}`);
      await mkdir(project, { recursive: true });
      await mkdir(outside);
      await row.plant(project, outside);
      const before = await snapshot(parent);
      assert.deepEqual(await new RustContentIndex(root).recorded(KEY), []);
      assert.equal(await snapshot(parent), before);
    });
  }

  it("never reads through a linked project folder", { skip: SKIP_ON_WINDOWS }, async () => {
    const parent = await realpath(await tmpDir("content-linked-"));
    const root = path.join(parent, "rust-builds");
    const elsewhere = path.join(parent, "elsewhere");
    await mkdir(root, { recursive: true });
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, `macos-x${CONTENT_RECORD_SUFFIX}`), record({}));
    await symlink(elsewhere, path.join(root, `game-${"4".repeat(12)}`));
    const before = await snapshot(parent);
    assert.deepEqual(await new RustContentIndex(root).recorded(KEY), []);
    assert.equal(await snapshot(parent), before);
    assert.ok((await stat(elsewhere)).isDirectory());
  });
});
