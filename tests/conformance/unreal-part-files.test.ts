/**
 * The gate reads a part's folder (`unreal/parts/<Part>/`) from a builder's copy of the game. A
 * builder writes that folder, so it is read only inside the game by real path, without following a
 * link, within size caps; anything else is refused or skipped and nothing is written.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PART_LIMITS, readOtherParts, readPartFiles } from "../../src/plugins/unreal/part-files.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MANIFEST = { title: "Lantern", goal: "", blueprints: [{ name: "BP_Lantern", base: "Actor" }] };

async function game() {
  const root = await realpath(await tmpDir("studio-part-files-"));
  const dir = path.join(root, "game");
  const part = path.join(dir, "unreal", "parts", "Lantern");
  await mkdir(part, { recursive: true });
  await writeFile(path.join(part, "part.json"), JSON.stringify(MANIFEST));
  await writeFile(path.join(part, "BP_Lantern.dsl"), "(event EventBeginPlay)");
  await writeFile(path.join(part, "test.json"), JSON.stringify({ steps: [{ shot: "a" }] }));
  await writeFile(path.join(part, "apply.py"), "genex.save()\n");
  return { root, dir, part };
}

async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.sort();
}

describe("reading a part's folder", () => {
  it("reads its declaration, Blueprint text, test and whether apply.py is there", async () => {
    const { dir, part } = await game();
    const read = await readPartFiles(dir, "Lantern");
    assert.equal(read.dir, part);
    assert.deepEqual(read.files.manifest, MANIFEST);
    assert.deepEqual(Object.keys(read.files.dsl), ["BP_Lantern.dsl"]);
    assert.equal(read.files.hasApply, true);
    assert.deepEqual(read.files.test, { steps: [{ shot: "a" }] });
  });

  it("names a file that isn't JSON instead of failing", async () => {
    const { dir, part } = await game();
    await writeFile(path.join(part, "part.json"), "{ not json");
    const read = await readPartFiles(dir, "Lantern");
    assert.match(read.files.manifestError ?? "", /part\.json isn't valid JSON/);
  });

  it("refuses hostile part names and folders, and writes nothing", async () => {
    const { root, dir } = await game();
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, "Evil"), { recursive: true });
    await writeFile(path.join(outside, "Evil", "part.json"), JSON.stringify(MANIFEST));
    await symlink(path.join(outside, "Evil"), path.join(dir, "unreal", "parts", "Linked"));
    const before = await snapshot(root);
    for (const name of ["../Lantern", "a/b", "", " ", "Lantern ", "x".repeat(65), "Linked", "Missing"]) {
      await assert.rejects(readPartFiles(dir, name), Error, JSON.stringify(name));
    }
    assert.deepEqual(await snapshot(root), before);
  });

  it("skips files that are links or too large, and never reads outside the folder", async () => {
    const { root, dir, part } = await game();
    const secret = path.join(root, "secret.dsl");
    await writeFile(secret, "(event Leaked)");
    await symlink(secret, path.join(part, "BP_Leak.dsl"));
    await writeFile(path.join(part, "BP_Big.dsl"), "x".repeat(PART_LIMITS.fileBytes + 1));
    await symlink(path.join(root, "secret.dsl"), path.join(part, "test.json.link"));
    const read = await readPartFiles(dir, "Lantern");
    assert.deepEqual(Object.keys(read.files.dsl), ["BP_Lantern.dsl"]);
    assert.equal(await readFile(secret, "utf8"), "(event Leaked)");
  });

  it("an apply.py that is a link doesn't count", async () => {
    const { root, dir, part } = await game();
    const { rm } = await import("node:fs/promises");
    await rm(path.join(part, "apply.py"));
    await writeFile(path.join(root, "evil.py"), "import os\n");
    await symlink(path.join(root, "evil.py"), path.join(part, "apply.py"));
    assert.equal((await readPartFiles(dir, "Lantern")).files.hasApply, false);
  });

  it("lists the game's other parts with what they declare, skipping unreadable ones", async () => {
    const { dir } = await game();
    const player = path.join(dir, "unreal", "parts", "Player");
    await mkdir(player);
    await writeFile(
      path.join(player, "part.json"),
      JSON.stringify({ title: "Player", goal: "", blueprints: [{ name: "BP_Player", base: "Character" }] }),
    );
    const broken = path.join(dir, "unreal", "parts", "Broken");
    await mkdir(broken);
    await writeFile(path.join(broken, "part.json"), "nope");
    const others = await readOtherParts(dir);
    assert.deepEqual(
      others.map((o) => [o.part, o.blueprints.map((b) => b.name)]),
      [
        ["Lantern", ["BP_Lantern"]],
        ["Player", ["BP_Player"]],
      ],
    );
  });
});
