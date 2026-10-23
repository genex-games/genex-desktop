/**
 * Each host's copy-on-write folder clone (`src/substrate/clone-tree.ts`) with its filesystem
 * calls injected, so every branch runs on every host: a Mac clones with `cp -c` only on the
 * system volume's kind of filesystem (Node's own `copyFile` cannot clone there), Linux reflinks
 * file by file where a probe clones, Windows has none. Every clone keeps timestamps, refuses a
 * link or special file, and leaves nothing at its destination when it fails.
 */
import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { cloneTreeByFile, hostTreeCloner } from "../../src/substrate/clone-tree.ts";
import { tmpDir } from "../helpers/tmp.ts";

const NO_LINKS = process.platform === "win32" ? "a link needs a privilege a Windows runner may not hold" : false;
const APFS = 26;
const HFS = 17;

/** A folder to clone: two files, one in a subfolder, with a timestamp of their own. */
async function source(parent: string): Promise<string> {
  const from = path.join(parent, "from");
  await mkdir(path.join(from, "debug"), { recursive: true });
  await writeFile(path.join(from, "debug", "engine"), "engine");
  await writeFile(path.join(from, "CACHEDIR.TAG"), "tag");
  await utimes(path.join(from, "debug", "engine"), 1_700_000_000, 1_700_000_000);
  return from;
}

const exists = async (file: string) => (await lstat(file).catch(() => null)) !== null;

describe("a Mac clones with cp -c, only on the system volume's filesystem (BC)", () => {
  it("clones where the root's filesystem is the system volume's (APFS), and nowhere else", async () => {
    const root = await realpath(await tmpDir("clone-mac-"));
    const types: Record<string, number> = { "/": APFS, [root]: APFS };
    const apfs = hostTreeCloner("darwin", { fsType: async (dir) => types[dir] ?? HFS });
    assert.ok(apfs);
    assert.equal(await apfs.supported(root), true);
    const other = hostTreeCloner("darwin", { fsType: async (dir) => (dir === "/" ? APFS : HFS) });
    assert.equal(await other?.supported(root), false, "an HFS+ or network volume copies, so it shares");
  });

  it("clones the whole folder with one cp -c -R -p, and leaves nothing when it fails", async () => {
    const parent = await realpath(await tmpDir("clone-mac-"));
    const from = await source(parent);
    const runs: string[][] = [];
    const cloner = hostTreeCloner("darwin", {
      fsType: async () => APFS,
      exec: async (file, args) => {
        runs.push([file, ...args]);
        await mkdir(String(args.at(-1)));
        throw new Error("cp: clonefile failed");
      },
    });
    const to = path.join(parent, "to");
    await assert.rejects(cloner?.clone(from, to) ?? Promise.resolve());
    assert.deepEqual(runs, [["/bin/cp", "-c", "-R", "-p", "--", from, to]]);
    assert.equal(await exists(to), false, "nothing left at the copy");
  });

  it("refuses a folder holding a link before cp runs", { skip: NO_LINKS }, async () => {
    const parent = await realpath(await tmpDir("clone-mac-"));
    const from = await source(parent);
    await symlink(parent, path.join(from, "debug", "link"));
    let ran = false;
    const cloner = hostTreeCloner("darwin", {
      fsType: async () => APFS,
      exec: async () => {
        ran = true;
      },
    });
    await assert.rejects(cloner?.clone(from, path.join(parent, "to")) ?? Promise.resolve());
    assert.equal(ran, false);
  });

  it("clones for real with the system's cp on this Mac, timestamps kept", {
    skip: process.platform !== "darwin",
  }, async () => {
    const parent = await realpath(await tmpDir("clone-mac-real-"));
    const from = await source(parent);
    const cloner = hostTreeCloner("darwin");
    const to = path.join(parent, "to");
    await cloner?.clone(from, to);
    assert.equal(await readFile(path.join(to, "debug", "engine"), "utf8"), "engine");
    assert.equal((await stat(path.join(to, "debug", "engine"))).mtimeMs, 1_700_000_000_000);
  });
});

describe("Linux reflinks file by file where a probe clones; Windows has no cloner (BC)", () => {
  /** A file clone that copies, as btrfs or XFS reflinks; every call recorded. */
  function reflinks() {
    const calls: string[] = [];
    const cloneFile = async (from: string, to: string) => {
      calls.push(from);
      await copyFile(from, to);
    };
    return { cloneFile, calls };
  }

  it("a probe file that clones in the root (btrfs, XFS) says yes; one ext4 refuses says no; both leave nothing", async () => {
    const root = await realpath(await tmpDir("clone-linux-"));
    const { cloneFile } = reflinks();
    assert.equal(await hostTreeCloner("linux", { cloneFile })?.supported(root), true);
    const refused = async () => {
      throw Object.assign(new Error("Operation not supported"), { code: "EOPNOTSUPP" });
    };
    assert.equal(await hostTreeCloner("linux", { cloneFile: refused })?.supported(root), false);
    assert.deepEqual(await readdir(root), []);
  });

  it("clones every file with its timestamps; a file that does not clone or a link leaves nothing", async () => {
    const parent = await realpath(await tmpDir("clone-linux-"));
    const from = await source(parent);
    const { cloneFile, calls } = reflinks();
    const to = path.join(parent, "to");
    await hostTreeCloner("linux", { cloneFile })?.clone(from, to);
    assert.equal(calls.length, 2);
    assert.equal(await readFile(path.join(to, "debug", "engine"), "utf8"), "engine");
    assert.equal((await stat(path.join(to, "debug", "engine"))).mtimeMs, 1_700_000_000_000);
    let cloned = 0;
    const failing = async (file: string, target: string) => {
      if (cloned++ > 0) throw new Error("No space left on device");
      await copyFile(file, target);
    };
    const failed = path.join(parent, "failed");
    await assert.rejects(cloneTreeByFile(from, failed, failing));
    assert.equal(await exists(failed), false);
    if (!NO_LINKS) {
      await symlink(parent, path.join(from, "debug", "link"));
      const linked = path.join(parent, "linked");
      await assert.rejects(cloneTreeByFile(from, linked, cloneFile));
      assert.equal(await exists(linked), false);
    }
  });

  it("a Windows host has no cloner: Node exposes no ReFS block cloning, and NTFS has none", () => {
    assert.equal(hostTreeCloner("win32"), null);
  });
});
