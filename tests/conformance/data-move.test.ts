/**
 * Moving Genex's data folder (Settings → Storage): every entry but the kept record goes to the new
 * folder, renamed on one volume or copied across volumes with progress. A move that fails leaves
 * the old folder whole and the new one as it was; links are copied as links, never followed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DataFolderProblem } from "../../src/shared/data-folder.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";
import {
  DataMoveError,
  DataMoveMode,
  EntryMove,
  measureData,
  moveData,
  removeEntries,
  SPARE_BYTES,
} from "../../src/substrate/data-move.ts";

const RECORD = "data-folder.json";
const ACROSS_VOLUMES = { sameVolume: async () => false, freeBytes: async () => Number.MAX_SAFE_INTEGER };

async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await realpath(await tmpDir("data-move-"));
  t.after(() => removeTree(dir));
  return dir;
}

/** A data folder like Genex's: settings, a run's copy of a game with a nested folder, the record. */
async function dataFolder(root: string): Promise<string> {
  const from = path.join(root, "from");
  await mkdir(path.join(from, "scratch", "autopilot", "run-1", "src"), { recursive: true });
  await writeFile(path.join(from, "projects.json"), '{"version":1}');
  await writeFile(path.join(from, "scratch", "autopilot", "run-1", "src", "main.js"), "x".repeat(4096));
  await writeFile(path.join(from, "scratch", "autopilot", "run-1", ".git"), "gitdir: /games/a/.git/worktrees/run-1\n");
  await writeFile(path.join(from, RECORD), "{}");
  return from;
}

/** Every file under `dir` as `relative path -> contents`, links as `-> target`. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    const full = path.join(dir, rel);
    const info = await lstat(full);
    if (info.isSymbolicLink()) out[rel] = `-> ${path.resolve(await readlink(full))}`;
    else if (info.isDirectory()) for (const name of await readdir(full)) await walk(path.join(rel, name));
    else out[rel] = await readFile(full, "utf8");
  };
  for (const name of await readdir(dir)) await walk(name);
  return out;
}

for (const [label, options, mode] of [
  ["on one volume", {}, DataMoveMode.Renamed],
  ["across volumes", ACROSS_VOLUMES, DataMoveMode.Copied],
] as const) {
  test(`a move ${label} carries every entry but the kept record`, async (t) => {
    const root = await scratch(t);
    const from = await dataFolder(root);
    const to = path.join(root, "to");
    await mkdir(to);
    const before = await tree(from);
    const moved = await moveData({ from, to, keep: [RECORD] }, options);
    assert.equal(moved.mode, mode);
    assert.deepEqual(moved.entries, ["projects.json", "scratch"]);
    const { [RECORD]: record, ...carried } = before;
    assert.deepEqual(await tree(to), carried);
    if (mode === DataMoveMode.Copied) {
      assert.deepEqual(await tree(from), before, "copies leave the originals until the caller removes them");
      assert.deepEqual(await removeEntries(from, moved.entries), []);
    }
    assert.deepEqual(await tree(from), { [RECORD]: record });
  });
}

test("a copy reports its bytes as it goes, after counting them", async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  const to = path.join(root, "to");
  await mkdir(to);
  const seen: Array<[number, number]> = [];
  await moveData(
    { from, to, keep: [RECORD] },
    { ...ACROSS_VOLUMES, onProgress: (done, total) => seen.push([done, total]) },
  );
  const total = await measureData(from, [RECORD]);
  assert.deepEqual(seen[0], [0, 0], "counting first");
  assert.deepEqual(seen.at(-1), [total, total]);
  assert.ok(seen.every(([done, of], i) => i === 0 || (of === total && done <= total)));
});

test("a link is copied as a link: its target outside the folder is neither read, counted nor written", async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "s".repeat(10_000));
  await symlink(outside, path.join(from, "scratch", "linked"), "junction");
  const to = path.join(root, "to");
  await mkdir(to);
  const before = await measureData(from, [RECORD]);
  assert.equal(before, 4096 + '{"version":1}'.length + "gitdir: /games/a/.git/worktrees/run-1\n".length);
  await moveData({ from, to, keep: [RECORD] }, ACROSS_VOLUMES);
  assert.equal(path.resolve(await readlink(path.join(to, "scratch", "linked"))), path.resolve(outside));
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
  await removeEntries(from, ["scratch"]);
  assert.deepEqual(await readdir(outside), ["secret.txt"], "removing the original link leaves its target");
});

/** Plans that must be refused before anything is written, with the problem Settings names. */
const REFUSED: Array<{
  name: string;
  plan: (root: string, from: string) => Promise<{ to: string; allowInTarget?: string[] }>;
  problem: DataFolderProblem;
}> = [
  {
    name: "a target inside the data folder",
    plan: async (_root, from) => {
      await mkdir(path.join(from, "inner"));
      return { to: path.join(from, "inner") };
    },
    problem: DataFolderProblem.Overlaps,
  },
  {
    name: "a target that holds the data folder",
    plan: async (root) => ({ to: root }),
    problem: DataFolderProblem.Overlaps,
  },
  {
    name: "a target with files in it",
    plan: async (root) => {
      const to = path.join(root, "to");
      await mkdir(to);
      await writeFile(path.join(to, "theirs.txt"), "keep me");
      return { to };
    },
    problem: DataFolderProblem.NotEmpty,
  },
  {
    name: "a target holding an entry the move would bring, even one it may hold",
    plan: async (root) => {
      const to = path.join(root, "to");
      await mkdir(to);
      await writeFile(path.join(to, "projects.json"), "theirs");
      return { to, allowInTarget: ["projects.json"] };
    },
    problem: DataFolderProblem.NotEmpty,
  },
  {
    name: "a target that is not there",
    plan: async (root) => ({ to: path.join(root, "gone") }),
    problem: DataFolderProblem.Missing,
  },
];

for (const row of REFUSED) {
  test(`refused before writing anything: ${row.name}`, async (t) => {
    const root = await scratch(t);
    const from = await dataFolder(root);
    const { to, allowInTarget } = await row.plan(root, from);
    const before = await tree(root);
    await assert.rejects(
      moveData({ from, to, keep: [RECORD], ...(allowInTarget ? { allowInTarget } : {}) }, ACROSS_VOLUMES),
      (error: unknown) => error instanceof DataMoveError && error.problem === row.problem,
    );
    assert.deepEqual(await tree(root), before);
  });
}

test("a target that only holds the record may take the data back into the default folder", async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  await rm(path.join(from, RECORD));
  const to = path.join(root, "default");
  await mkdir(to);
  await writeFile(path.join(to, RECORD), '{"dir":"elsewhere"}');
  await moveData({ from, to, keep: [], allowInTarget: [RECORD] }, ACROSS_VOLUMES);
  assert.deepEqual((await readdir(to)).sort(), [RECORD, "projects.json", "scratch"]);
});

test("too little free space is refused before copying", async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  const to = path.join(root, "to");
  await mkdir(to);
  const before = await tree(root);
  await assert.rejects(
    moveData({ from, to, keep: [RECORD] }, { sameVolume: async () => false, freeBytes: async () => SPARE_BYTES }),
    (error: unknown) => error instanceof DataMoveError && error.problem === DataFolderProblem.NoSpace,
  );
  assert.deepEqual(await tree(root), before);
});

test("a copy that fails part-way takes back what it copied and leaves the old folder whole", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  const locked = path.join(from, "scratch", "autopilot", "run-1", "src", "main.js");
  await chmod(locked, 0o000);
  const to = path.join(root, "to");
  await mkdir(to);
  await assert.rejects(moveData({ from, to, keep: [RECORD] }, ACROSS_VOLUMES), DataMoveError);
  assert.deepEqual(await readdir(to), []);
  await chmod(locked, 0o644);
  assert.equal((await readFile(locked, "utf8")).length, 4096);
  assert.deepEqual((await readdir(from)).sort(), [RECORD, "projects.json", "scratch"]);
});

/** POSIX permissions stand in for a file another program holds; Windows and root ignore them. */
const NO_CHMOD = process.platform === "win32" || process.getuid?.() === 0;

test("renames cut short and stopped again: what cannot go back is named stranded, never silently dropped", {
  skip: NO_CHMOD,
}, async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  const to = path.join(root, "to");
  await mkdir(to);
  // The earlier attempt renamed projects.json, then Genex closed; now the old folder refuses changes.
  await rename(path.join(from, "projects.json"), path.join(to, "projects.json"));
  await chmod(from, 0o555);
  await assert.rejects(
    moveData({ from, to, keep: [RECORD], resume: ["projects.json", "scratch"] }),
    (error: unknown) =>
      error instanceof DataMoveError && error.stranded.join() === "projects.json" && error.left.length === 0,
  );
  await chmod(from, 0o755);
  assert.deepEqual((await readdir(from)).sort(), [RECORD, "scratch"], "scratch never left");
  assert.deepEqual(await readdir(to), ["projects.json"]);
});

test("a resumed copy whose half copy cannot be removed stops, names that copy left, and the old folder stays whole", {
  skip: NO_CHMOD,
}, async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  const to = path.join(root, "to");
  const half = path.join(to, "scratch", "autopilot");
  await mkdir(half, { recursive: true });
  await writeFile(path.join(half, "part.bin"), "partial");
  await chmod(half, 0o555);
  await assert.rejects(
    moveData({ from, to, keep: [RECORD], resume: ["projects.json", "scratch"] }, ACROSS_VOLUMES),
    (error: unknown) =>
      error instanceof DataMoveError &&
      error.problem === DataFolderProblem.InUse &&
      error.stranded.length === 0 &&
      error.left.join() === "scratch",
  );
  await chmod(half, 0o755);
  assert.deepEqual((await readdir(from)).sort(), [RECORD, "projects.json", "scratch"]);
});

test("on one volume a failure never removes a renamed entry's new side, even when its old name came back", {
  skip: NO_CHMOD,
}, async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  const to = path.join(root, "to");
  await mkdir(to);
  // The earlier attempt renamed projects.json; something wrote the name again in the old folder.
  await rename(path.join(from, "projects.json"), path.join(to, "projects.json"));
  await writeFile(path.join(from, "projects.json"), "written after the rename");
  await chmod(from, 0o555);
  try {
    await assert.rejects(
      moveData({
        from,
        to,
        keep: [RECORD],
        resume: ["projects.json", "scratch"],
        done: { "projects.json": EntryMove.Renamed },
      }),
      (error: unknown) => error instanceof DataMoveError && error.stranded.includes("projects.json"),
    );
  } finally {
    await chmod(from, 0o755);
  }
  assert.equal(await readFile(path.join(to, "projects.json"), "utf8"), '{"version":1}', "the moved data stays");
  assert.equal(await readFile(path.join(from, "projects.json"), "utf8"), "written after the rename");
});

test("carrying on after renames: a renamed entry whose old name came back is doubled, both sides kept", async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  const to = path.join(root, "to");
  await mkdir(to);
  await rename(path.join(from, "projects.json"), path.join(to, "projects.json"));
  await mkdir(path.join(from, "projects.json"));
  const moved = await moveData({
    from,
    to,
    keep: [RECORD],
    resume: ["projects.json", "scratch"],
    done: { "projects.json": EntryMove.Renamed },
  });
  assert.deepEqual(moved.doubled, ["projects.json"]);
  assert.deepEqual(moved.copied, []);
  assert.equal(await readFile(path.join(to, "projects.json"), "utf8"), '{"version":1}');
  assert.deepEqual((await readdir(to)).sort(), ["projects.json", "scratch"]);
});

test("a volume that will not rename across itself (EXDEV) has that entry and the rest copied", async (t) => {
  const root = await scratch(t);
  const from = await dataFolder(root);
  const to = path.join(root, "to");
  await mkdir(to);
  const told: Array<[string, string]> = [];
  const moved = await moveData(
    { from, to, keep: [RECORD] },
    {
      sameVolume: async () => true,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      rename: async (a, b) => {
        if (path.basename(a) === "scratch")
          throw Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" });
        await rename(a, b);
      },
      onEntryMoved: async (name, how) => {
        told.push([name, how]);
      },
    },
  );
  assert.deepEqual(told, [
    ["projects.json", EntryMove.Renamed],
    ["scratch", EntryMove.Copied],
  ]);
  assert.equal(moved.mode, DataMoveMode.Copied);
  assert.deepEqual(moved.copied, ["scratch"]);
  assert.deepEqual((await readdir(from)).sort(), [RECORD, "scratch"], "the copied original stays for the caller");
  assert.deepEqual((await readdir(to)).sort(), ["projects.json", "scratch"]);
});
