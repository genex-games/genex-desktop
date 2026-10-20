/**
 * The heavy profile CI seeds before the packaged first start (scripts/ci-heavy-profile.mjs): the
 * size it is asked for, every folder Genex denies on Windows (srt-win stamps a deny path only when
 * it exists), files already there kept as they were, and never a home outside a GitHub Actions runner.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { DENIED_FOLDERS, profileFiles, seedProfile, seedTarget } from "../../scripts/ci-heavy-profile.mjs";
import { windowsDenyRead } from "../../src/substrate/windows-sandbox.ts";
import { removeAll, tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);
const SCRIPT = path.resolve("scripts/ci-heavy-profile.mjs");
const SMALL_PROFILE = 2_000;
const made: string[] = [];

after(() => removeAll(made));

async function fresh(prefix: string): Promise<string> {
  const dir = await tmpDir(prefix);
  made.push(dir);
  return dir;
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

describe("heavy profile seeding", () => {
  it("lays out exactly the requested number of distinct files, spread over caches and package trees", () => {
    const files = profileFiles(SMALL_PROFILE);
    assert.equal(files.length, SMALL_PROFILE);
    assert.equal(new Set(files).size, SMALL_PROFILE);
    assert.ok(files.some((file) => file.includes("/node_modules/pkg-")));
    assert.ok(files.some((file) => file.startsWith("AppData/Local/npm-cache/_cacache/")));
    assert.ok(files.some((file) => file.startsWith("Documents/")));
  });

  it("seeds only folders Genex denies on Windows, so each one makes srt-win stamp its parent", () => {
    const home = String.raw`C:\Users\dev`;
    const env = {
      APPDATA: String.raw`C:\Users\dev\AppData\Roaming`,
      LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`,
    };
    const denied = new Set(windowsDenyRead(home, env).map((p) => path.win32.normalize(p).toLowerCase()));
    for (const folder of DENIED_FOLDERS) {
      const full = path.win32.normalize(path.win32.join(home, ...folder.split("/"))).toLowerCase();
      assert.ok(denied.has(full), `${folder} is not on windowsDenyRead`);
    }
  });

  it("writes every file and denied folder, and keeps a file that was already there", async () => {
    const root = await fresh("heavy-profile-");
    await mkdir(path.join(root, ".ssh"), { recursive: true });
    await writeFile(path.join(root, ".ssh", "placeholder"), "the person's own\n");
    const seeded = await seedProfile(root, SMALL_PROFILE);
    assert.deepEqual([seeded.files, seeded.written], [SMALL_PROFILE, SMALL_PROFILE - 1]);
    assert.equal((await filesUnder(root)).length, SMALL_PROFILE);
    for (const folder of DENIED_FOLDERS) assert.ok((await readdir(path.join(root, ...folder.split("/")))).length > 0);
    assert.equal(await readFile(path.join(root, ".ssh", "placeholder"), "utf8"), "the person's own\n");
    const again = await seedProfile(root, SMALL_PROFILE);
    assert.equal(again.written, 0);
  });

  it("refuses every target but a disposable runner's home or a new, empty folder", async () => {
    const home = await fresh("heavy-home-");
    const busy = await fresh("heavy-busy-");
    await writeFile(path.join(busy, "notes.txt"), "kept\n");
    const outside = [
      { name: "the home, with no --root", root: undefined },
      { name: "the home itself", root: home },
      { name: "a folder holding the home", root: path.dirname(home) },
      { name: "a folder with files in it", root: busy },
    ];
    for (const { name, root } of outside) {
      const target = await seedTarget({ root, home, ci: false });
      assert.ok("refused" in target, `${name} was accepted`);
    }
    assert.deepEqual(await seedTarget({ root: undefined, home, ci: true }), { root: home });
    const empty = path.join(home, "..", `${path.basename(home)}-new`);
    made.push(empty);
    assert.deepEqual(await seedTarget({ root: empty, home, ci: false }), { root: path.resolve(empty) });
  });

  it("run outside GitHub Actions, writes nothing to the home and fails", async () => {
    const home = await fresh("heavy-home-");
    const env = { ...process.env, HOME: home, USERPROFILE: home, GITHUB_ACTIONS: "false" };
    const failed = await run(process.execPath, [SCRIPT, "--files", "100"], { env }).then(
      () => null,
      (error: { code?: number; stdout?: string }) => error,
    );
    assert.equal(failed?.code, 1);
    assert.match(failed?.stdout ?? "", /::error title=Heavy profile::/);
    assert.deepEqual(await readdir(home), []);
  });
});
