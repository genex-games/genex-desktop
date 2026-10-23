/**
 * How the Rust lane's build folders share a game's compiled engine, and what the sweep removes
 * (`src/main/rust-build-cache.ts`, through `RustBuilds.sweep`): each host's branch (a clone
 * copy-on-write where the filesystem has one, one shared target per game where it does not, and
 * every Windows host shared), the donor a new copy's target is cloned from (same game, destination
 * and lock, idle, admitted, reached through no link), the clone that leaves nothing when it fails,
 * and the sweep's rules with a hostile-input table that deletes nothing outside the lane's root.
 * No cargo runs: these rows hold on every host (the lane's builds over a stub cargo are in
 * `rust-build.test.ts`, each host's cloner in `clone-tree.test.ts`).
 */
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, readFile, realpath, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  freshestDonor,
  RustTargetSharing,
  rustTargetSharing,
  sharedTargetDir,
  UNSTAMPED_GRACE_MS,
} from "../../src/main/rust-build-cache.ts";
import { RustBuilds, type RustBuildsOptions } from "../../src/main/rust-build.ts";
import { hostTreeCloner, type TreeCloner } from "../../src/substrate/clone-tree.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: "c".repeat(64),
};
const LOCK12 = LOCK.digest.slice(0, 12);
const WEB = `web-${LOCK12}`;
const MAC = `macos-${LOCK12}`;
const NO_LINKS = process.platform === "win32" ? "a link needs a privilege a Windows runner may not hold" : false;
const NO_MODES = process.platform === "win32" ? "Windows deletes a read-only folder's entries" : false;
const NOW = Date.parse("2026-10-24T12:00:00Z");

/** A host cloner that answers `supported`, recording each root it is asked about. */
function clonerAnswering(supported: boolean) {
  const asked: string[] = [];
  const cloner: TreeCloner = {
    supported: async (root) => {
      asked.push(root);
      return supported;
    },
    clone: async () => assert.fail("the check clones nothing"),
  };
  return { cloner, asked };
}

describe("each host's branch: clone where the filesystem can, share where it cannot (BC)", () => {
  it("a root on a filesystem that clones (APFS, btrfs, XFS) builds each copy in a clone", async () => {
    const root = path.join(await tmpDir("rust-sharing-"), "rust-builds");
    const { cloner, asked } = clonerAnswering(true);
    assert.equal(await rustTargetSharing(root, cloner), RustTargetSharing.Clone);
    assert.deepEqual(asked, [root], "asked about the lane's own root, made first");
    assert.equal((await stat(root)).isDirectory(), true);
  });

  it("a root on one that does not (ext4, HFS+, a network volume) shares one target per game", async () => {
    const root = path.join(await tmpDir("rust-sharing-"), "rust-builds");
    assert.equal(await rustTargetSharing(root, clonerAnswering(false).cloner), RustTargetSharing.Shared);
    const failing: TreeCloner = {
      supported: async () => {
        throw new Error("statfs failed");
      },
      clone: async () => {},
    };
    assert.equal(await rustTargetSharing(root, failing), RustTargetSharing.Shared, "a check that fails shares");
  });

  it("a host with no cloner (Windows) shares", async () => {
    const root = path.join(await tmpDir("rust-sharing-"), "rust-builds");
    assert.equal(await rustTargetSharing(root, hostTreeCloner("win32")), RustTargetSharing.Shared);
  });

  it("a game's shared target is its own, per destination and lock, under the lane's root; an unnamed game shares none", () => {
    const root = path.resolve("/builds");
    assert.equal(sharedTargetDir(root, "pond", WEB), path.join(root, "shared", "pond-targets", WEB));
    assert.notEqual(sharedTargetDir(root, "pond", WEB), sharedTargetDir(root, "pond", MAC));
    assert.notEqual(sharedTargetDir(root, "pond", WEB), sharedTargetDir(root, "lake", WEB));
    // A device name Windows reserves is no folder there: the suffix keeps it one.
    assert.equal(sharedTargetDir(root, "con", WEB), path.join(root, "shared", "con-targets", WEB));
    assert.equal(sharedTargetDir(root, null, WEB), null);
    assert.equal(sharedTargetDir(root, "pond", "../../escape"), null);
  });
});

/** A build root with build folders of copies of games, each admitted at `at` with a target holding one file. */
async function buildRoot() {
  const parent = await realpath(await tmpDir("rust-donor-"));
  const root = path.join(parent, "rust-builds");
  await mkdir(root);
  const made = async (project: string, build: string, at: number | null) => {
    const bin = path.join(root, project, build);
    await mkdir(path.join(bin, "target", "debug"), { recursive: true });
    await writeFile(path.join(bin, "target", "debug", "engine"), `${project}/${build}`);
    if (at !== null) {
      await writeFile(`${bin}.admitted`, "[]");
      await utimes(`${bin}.admitted`, at / 1000, at / 1000);
    }
    return bin;
  };
  return { parent, root, made };
}

function donorQuery(root: string, bin: string, busy: ReadonlySet<string> = new Set()) {
  return {
    root,
    bin,
    folder: "pond",
    targetOf: (dir: string) => path.join(dir, "target"),
    admittedOf: (dir: string) => `${dir}.admitted`,
    busy: (dir: string) => busy.has(dir),
  };
}

describe("a new copy's target is cloned from the freshest idle copy of the same game, destination and lock (BC)", () => {
  it("picks the most recently admitted copy, and never another game, destination, lock, its own folder or a busy one", async () => {
    const { root, made } = await buildRoot();
    const older = await made(`pond-${"1".repeat(12)}`, WEB, NOW - 60_000);
    const fresher = await made(`pond-${"2".repeat(12)}`, WEB, NOW - 1_000);
    await made(`pond-${"3".repeat(12)}`, MAC, NOW);
    await made(`pond-${"4".repeat(12)}`, `web-${"d".repeat(12)}`, NOW);
    await made(`ponds-${"5".repeat(12)}`, WEB, NOW);
    await made(`big-pond-${"6".repeat(12)}`, WEB, NOW);
    await made(`pond-${"7".repeat(12)}`, WEB, null);
    const bin = path.join(root, `pond-${"8".repeat(12)}`, WEB);
    assert.equal(await freshestDonor(donorQuery(root, bin)), fresher);
    assert.equal(await freshestDonor(donorQuery(root, bin, new Set([fresher]))), older, "a busy copy lends nothing");
    assert.equal(await freshestDonor(donorQuery(root, fresher, new Set([older]))), null, "never its own folder");
  });

  it("refuses a donor reached through a link: a linked game folder, build folder or target", {
    skip: NO_LINKS,
  }, async () => {
    const { parent, root, made } = await buildRoot();
    const outside = await made(`elsewhere-${"9".repeat(12)}`, WEB, NOW);
    const bin = path.join(root, `pond-${"8".repeat(12)}`, WEB);
    await symlink(path.dirname(outside), path.join(root, `pond-${"1".repeat(12)}`));
    await mkdir(path.join(root, `pond-${"2".repeat(12)}`));
    await symlink(outside, path.join(root, `pond-${"2".repeat(12)}`, WEB));
    await writeFile(`${path.join(root, `pond-${"2".repeat(12)}`, WEB)}.admitted`, "[]");
    const linkedTarget = path.join(root, `pond-${"3".repeat(12)}`, WEB);
    await mkdir(linkedTarget, { recursive: true });
    await symlink(path.join(outside, "target"), path.join(linkedTarget, "target"));
    await writeFile(`${linkedTarget}.admitted`, "[]");
    assert.equal(await freshestDonor(donorQuery(root, bin)), null);
    assert.ok(parent);
  });
});

/** A lane that only sweeps: every build step fails the test. */
function sweeper(root: string, options: Partial<RustBuildsOptions> = {}) {
  return new RustBuilds({
    root,
    sandbox: async () => assert.fail("the sweep builds nothing"),
    locate: async () => assert.fail("the sweep locates nothing"),
    currentLock: async () => LOCK,
    stage: async () => assert.fail("the sweep stages nothing"),
    emit: () => {},
    platform: process.platform,
    cores: 8,
    denyWrite: [],
    writeLock: async () => {},
    now: () => NOW,
    ...options,
  });
}

/** A build folder with every sibling the lane leaves, stamped with `source` (null: no stamp), made `age` ago. */
async function builtFolder(root: string, project: string, build: string, source: string | null, age = 0) {
  const bin = path.join(root, project, build);
  await mkdir(path.join(bin, "target"), { recursive: true });
  for (const sibling of [".out", ".stage", ".cargo", ".home"]) await mkdir(`${bin}${sibling}`, { recursive: true });
  await writeFile(`${bin}.admitted`, "[]");
  if (source !== null) await writeFile(`${bin}.source`, source);
  const at = (NOW - age) / 1000;
  await utimes(bin, at, at);
  return bin;
}

const exists = async (file: string) => (await lstat(file).catch(() => null)) !== null;

describe("the sweep removes build folders whose source is gone, never one in use, nothing outside (BC)", () => {
  it("removes an idle folder whose source is gone with every sibling, and keeps one whose source is there", async () => {
    const parent = await realpath(await tmpDir("rust-sweep-gone-"));
    const root = path.join(parent, "rust-builds");
    const live = path.join(parent, "game");
    await mkdir(live);
    const kept = await builtFolder(root, `pond-${"1".repeat(12)}`, WEB, live);
    const gone = await builtFolder(root, `pond-${"2".repeat(12)}`, WEB, path.join(parent, "worktree-merged"));
    assert.equal(await sweeper(root).sweep(), 1);
    assert.equal(await exists(kept), true);
    assert.deepEqual(await readdir(root), [`pond-${"1".repeat(12)}`], "the gone copy's game folder went too");
    assert.equal(await exists(`${gone}.out`), false);
  });

  it("keeps a folder whose output a preview serves, and skips the whole sweep when the app cannot say what it serves", async () => {
    const parent = await realpath(await tmpDir("rust-sweep-served-"));
    const root = path.join(parent, "rust-builds");
    const served = await builtFolder(root, `pond-${"1".repeat(12)}`, WEB, path.join(parent, "show-discarded"));
    assert.equal(await sweeper(root, { inUse: () => [`${served}.out`] }).sweep(), 0);
    assert.equal(await exists(served), true);
    const unreadable = sweeper(root, {
      inUse: () => {
        throw new Error("the previews are unreadable");
      },
    });
    assert.equal(await unreadable.sweep(), 0);
    assert.equal(await exists(served), true);
  });

  it("leaves a half-written folder (no stamp yet) for the grace, and removes it after", async () => {
    const parent = await realpath(await tmpDir("rust-sweep-half-"));
    const root = path.join(parent, "rust-builds");
    const fresh = await builtFolder(root, `pond-${"1".repeat(12)}`, WEB, null, 60_000);
    const stale = await builtFolder(root, `pond-${"2".repeat(12)}`, WEB, null, UNSTAMPED_GRACE_MS + 60_000);
    assert.equal(await sweeper(root).sweep(), 1);
    assert.equal(await exists(fresh), true);
    assert.equal(await exists(stale), false);
  });

  it("removes a game's shared target once no copy has that build folder, and keeps it while one does", async () => {
    const parent = await realpath(await tmpDir("rust-sweep-shared-"));
    const root = path.join(parent, "rust-builds");
    const live = path.join(parent, "game");
    await mkdir(live);
    await builtFolder(root, `pond-${"1".repeat(12)}`, WEB, live);
    await builtFolder(root, `pond-${"2".repeat(12)}`, MAC, path.join(parent, "gone"));
    const web = sharedTargetDir(root, "pond", WEB);
    const mac = sharedTargetDir(root, "pond", MAC);
    const lake = sharedTargetDir(root, "lake", WEB);
    assert.ok(web && mac && lake);
    for (const dir of [web, mac, lake]) await mkdir(path.join(dir, "debug"), { recursive: true });
    assert.equal(await sweeper(root).sweep(), 3, "the gone copy's folder, and the Mac and lake shared targets");
    assert.equal(await exists(web), true);
    assert.equal(await exists(mac), false);
    assert.equal(await exists(path.dirname(lake)), false);
  });

  it("skips a folder it cannot remove (a Windows file lock, a permission), keeps its stamp, and sweeps the rest", {
    skip: NO_MODES,
  }, async (t) => {
    if (process.getuid?.() === 0) return t.skip("root removes a read-only folder's entries");
    const parent = await realpath(await tmpDir("rust-sweep-locked-"));
    const root = path.join(parent, "rust-builds");
    const locked = await builtFolder(root, `pond-${"1".repeat(12)}`, WEB, path.join(parent, "gone-a"));
    await writeFile(path.join(locked, "target", "held"), "held");
    const free = await builtFolder(root, `pond-${"2".repeat(12)}`, WEB, path.join(parent, "gone-b"));
    await chmod(path.join(locked, "target"), 0o500);
    try {
      assert.equal(await sweeper(root).sweep(), 1);
      assert.equal(await exists(`${locked}.source`), true, "the stamp stays for the next sweep");
      assert.equal(await exists(free), false);
    } finally {
      await chmod(path.join(locked, "target"), 0o700);
    }
    assert.equal(await sweeper(root).sweep(), 1, "the next sweep removes it");
  });
});

describe("the sweep's hostile inputs delete nothing outside the lane's root (BC)", { skip: NO_LINKS }, () => {
  /** A folder outside the root with a file in it, and a check that both are untouched. */
  async function outsideFolder(parent: string) {
    const outside = path.join(parent, "outside");
    await mkdir(path.join(outside, "inner"), { recursive: true });
    await writeFile(path.join(outside, "inner", "keep"), "kept");
    await writeFile(`${outside}.source`, path.join(parent, "nothing-here"));
    return {
      outside,
      intact: async (label: string) => {
        assert.equal(await readFile(path.join(outside, "inner", "keep"), "utf8"), "kept", label);
        assert.equal(await exists(`${outside}.source`), true, label);
      },
    };
  }

  const ROWS: [string, (root: string, parent: string, outside: string) => Promise<void>][] = [
    [
      "a stamp naming a folder outside the profile that is there: kept",
      async (root, _parent, outside) => {
        await builtFolder(root, `pond-${"1".repeat(12)}`, WEB, outside);
      },
    ],
    [
      "a stamp naming a path outside the profile that is gone: only the folder inside goes",
      async (root, parent) => {
        await builtFolder(root, `pond-${"1".repeat(12)}`, WEB, path.join(parent, "outside", "gone"));
      },
    ],
    [
      "a build folder that is a link to a folder outside: the link alone goes",
      async (root, _parent, outside) => {
        await mkdir(path.join(root, `pond-${"1".repeat(12)}`), { recursive: true });
        await symlink(outside, path.join(root, `pond-${"1".repeat(12)}`, WEB));
      },
    ],
    [
      "an output beside a gone source that is a link outside: the link alone goes",
      async (root, parent, outside) => {
        const bin = await builtFolder(root, `pond-${"1".repeat(12)}`, WEB, path.join(parent, "gone"));
        await removeTree(`${bin}.out`);
        await symlink(outside, `${bin}.out`);
      },
    ],
    [
      "a source stamp that is a link: unread, left for the grace",
      async (root, _parent, outside) => {
        const bin = await builtFolder(root, `pond-${"1".repeat(12)}`, WEB, null);
        await symlink(`${outside}.source`, `${bin}.source`);
      },
    ],
    [
      "a game folder that is a link to a folder outside: never entered",
      async (root, _parent, outside) => {
        await symlink(outside, path.join(root, `pond-${"1".repeat(12)}`));
      },
    ],
    [
      "a shared folder that is a link outside: never entered",
      async (root, _parent, outside) => {
        await symlink(outside, path.join(root, "shared"));
      },
    ],
    [
      "a game's shared targets folder that is a link outside: never entered",
      async (root, _parent, outside) => {
        await mkdir(path.join(root, "shared"), { recursive: true });
        await symlink(outside, path.join(root, "shared", "pond-targets"));
      },
    ],
  ];

  for (const [label, plant] of ROWS) {
    it(label, async () => {
      const parent = await realpath(await tmpDir("rust-sweep-hostile-"));
      const root = path.join(parent, "rust-builds");
      await mkdir(root, { recursive: true });
      const { outside, intact } = await outsideFolder(parent);
      await mkdir(path.join(outside, WEB), { recursive: true });
      await plant(root, parent, outside);
      await sweeper(root).sweep();
      await intact(label);
      assert.equal(await exists(path.join(outside, WEB)), true, label);
    });
  }
});
