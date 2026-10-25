/**
 * Settings → Storage's data folder: a folder from the picker is checked before anything is
 * written, and only the folder picked last can be moved to. The move records the folder for the
 * next start and restarts Genex; a refused folder writes nothing and restarts nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DATA_FOLDER_NAME,
  createDataFolderChoices,
  type DataFolderChoiceDeps,
} from "../../src/main/data-folder-choice.ts";
import { DATA_FOLDER_FILE, writeDataFolderRecord } from "../../src/main/data-folder.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { DataFolderProblem } from "../../src/shared/data-folder.ts";
import { SPARE_BYTES } from "../../src/substrate/data-move.ts";
import { type DriveFacts, DriveKind } from "../../src/substrate/windows-drive.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const NTFS: DriveFacts = { kind: DriveKind.Fixed, fileSystem: "NTFS" };
const DATA_BYTES = 5_000;

/** A machine: Electron's default folder holding the data, a games folder, an install and a second drive. */
async function machine(t: { after(fn: () => Promise<void>): void }, overrides: Partial<DataFolderChoiceDeps> = {}) {
  const root = await realpath(await tmpDir("data-choice-"));
  t.after(() => removeTree(root));
  const defaultDir = path.join(root, "AppData", "Genex");
  const games = path.join(root, "AI Games");
  const install = path.join(root, "Local", "genex");
  const drive = path.join(root, "D");
  for (const dir of [defaultDir, games, install, drive]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(defaultDir, "projects.json"), "{}");
  const calls = { restarts: 0, lockedDown: [] as string[], logged: [] as string[] };
  const deps: DataFolderChoiceDeps = {
    platform: StudioPlatform.Windows,
    normal: true,
    defaultDir,
    dataDir: defaultDir,
    occupied: async () => [games, path.join(games, "Racer"), install],
    busy: () => false,
    drive: async () => NTFS,
    lockDown: async (dir) => {
      calls.lockedDown.push(dir);
    },
    measure: async () => DATA_BYTES,
    free: async () => DATA_BYTES + SPARE_BYTES,
    sameVolume: async () => false,
    restart: () => {
      calls.restarts++;
    },
    log: (line) => calls.logged.push(line),
    ...overrides,
  };
  return { root, defaultDir, games, install, drive, deps, calls, choices: createDataFolderChoices(deps) };
}

test("an empty folder is taken as it is; moving to it records it, locks it down and restarts", async (t) => {
  const { drive, defaultDir, choices, calls } = await machine(t);
  const empty = path.join(drive, "Genex data");
  await mkdir(empty);
  assert.deepEqual(await choices.choose(empty), { ok: true, to: empty, bytes: DATA_BYTES });
  assert.deepEqual(await choices.move(), { ok: true, to: empty, bytes: DATA_BYTES });
  assert.deepEqual(calls.lockedDown, [empty]);
  assert.equal(calls.restarts, 1);
  const record = JSON.parse(await readFile(path.join(defaultDir, DATA_FOLDER_FILE), "utf8"));
  assert.deepEqual(record, { moveTo: empty });
});

test("a drive's root or a folder with files in it gets a Genex folder of its own", async (t) => {
  const { drive, choices } = await machine(t);
  const busyFolder = path.join(drive, "Stuff");
  await mkdir(busyFolder);
  await writeFile(path.join(busyFolder, "photo.jpg"), "x");
  assert.deepEqual(await choices.choose(busyFolder), {
    ok: true,
    to: path.join(busyFolder, DATA_FOLDER_NAME),
    bytes: DATA_BYTES,
  });
  const rootPick = path.parse(drive).root;
  const choice = await choices.choose(rootPick);
  assert.equal(choice.to, path.join(rootPick, DATA_FOLDER_NAME));
});

test("moving back into the default folder is allowed though it holds the record", async (t) => {
  const { drive, defaultDir, deps } = await machine(t);
  const chosen = path.join(drive, "Genex");
  await mkdir(chosen);
  await writeDataFolderRecord(defaultDir, { dir: chosen });
  const choices = createDataFolderChoices({ ...deps, dataDir: chosen });
  assert.deepEqual(await choices.choose(defaultDir), { ok: true, to: defaultDir, bytes: DATA_BYTES });
});

/** Folders and situations refused before anything is written, with the problem Settings names. */
const REFUSED: Array<{
  name: string;
  pick: (m: Awaited<ReturnType<typeof machine>>) => Promise<string>;
  deps?: Partial<DataFolderChoiceDeps>;
  problem: DataFolderProblem;
}> = [
  { name: "the folder already in use", pick: async (m) => m.defaultDir, problem: DataFolderProblem.Same },
  {
    name: "a folder inside Genex's files",
    pick: async (m) => {
      const inner = path.join(m.defaultDir, "inner");
      await mkdir(inner);
      return inner;
    },
    problem: DataFolderProblem.Overlaps,
  },
  {
    name: "the games folder",
    pick: async (m) => {
      const inGames = path.join(m.games, "Racer");
      await mkdir(inGames);
      return inGames;
    },
    problem: DataFolderProblem.Overlaps,
  },
  { name: "Genex's install", pick: async (m) => m.install, problem: DataFolderProblem.Overlaps },
  {
    name: "a folder whose Genex folder already has files",
    pick: async (m) => {
      await mkdir(path.join(m.drive, DATA_FOLDER_NAME));
      await writeFile(path.join(m.drive, DATA_FOLDER_NAME, "old.txt"), "x");
      await writeFile(path.join(m.drive, "other.txt"), "x");
      return m.drive;
    },
    problem: DataFolderProblem.NotEmpty,
  },
  {
    name: "a network drive",
    pick: async (m) => m.drive,
    deps: { drive: async () => ({ kind: DriveKind.Network, fileSystem: "NTFS" }) },
    problem: DataFolderProblem.Network,
  },
  {
    name: "a USB stick",
    pick: async (m) => m.drive,
    deps: { drive: async () => ({ kind: DriveKind.Removable, fileSystem: "NTFS" }) },
    problem: DataFolderProblem.Removable,
  },
  {
    name: "a drive that keeps no permissions",
    pick: async (m) => m.drive,
    deps: { drive: async () => ({ kind: DriveKind.Fixed, fileSystem: "exFAT" }) },
    problem: DataFolderProblem.FileSystem,
  },
  {
    name: "too little free space",
    pick: async (m) => m.drive,
    deps: { free: async () => DATA_BYTES },
    problem: DataFolderProblem.NoSpace,
  },
  {
    name: "a build under way",
    pick: async (m) => m.drive,
    deps: { busy: () => true },
    problem: DataFolderProblem.Busy,
  },
  {
    name: "a developer or test launch",
    pick: async (m) => m.drive,
    deps: { normal: false },
    problem: DataFolderProblem.Unsupported,
  },
  {
    name: "another system than Windows",
    pick: async (m) => m.drive,
    deps: { platform: StudioPlatform.Mac },
    problem: DataFolderProblem.Unsupported,
  },
];

for (const row of REFUSED) {
  test(`refused, with nothing written: ${row.name}`, async (t) => {
    const m = await machine(t, row.deps);
    const picked = await row.pick(m);
    const before = await readdir(m.defaultDir);
    const choice = await m.choices.choose(picked);
    assert.equal(choice.ok, false);
    assert.equal(!choice.ok && choice.problem, row.problem);
    const move = await m.choices.move();
    assert.equal(move.ok, false, "a refused folder is never the one a move goes to");
    assert.deepEqual(await readdir(m.defaultDir), before, "no record written");
    assert.equal(m.calls.restarts, 0);
    assert.deepEqual(m.calls.lockedDown, []);
  });
}

test("a move asked for with no folder picked, or after a refusal, moves nothing", async (t) => {
  const m = await machine(t);
  assert.deepEqual(await m.choices.move(), { ok: false, to: null, problem: DataFolderProblem.Unsupported });
  const empty = path.join(m.drive, "Genex");
  await mkdir(empty);
  assert.equal((await m.choices.choose(empty)).ok, true);
  assert.equal((await m.choices.choose(m.install)).ok, false);
  assert.equal((await m.choices.move()).ok, false);
  assert.equal(m.calls.restarts, 0);
});

test("a folder Windows will not lock down is refused, and a drive without permissions says so", async (t) => {
  let facts: DriveFacts = NTFS;
  const m = await machine(t, {
    drive: async () => facts,
    lockDown: async () => {
      throw new Error("icacls: This operation is not supported");
    },
  });
  const empty = path.join(m.drive, "Genex");
  await mkdir(empty);
  assert.equal((await m.choices.choose(empty)).ok, true);
  assert.deepEqual(await m.choices.move(), { ok: false, to: empty, problem: DataFolderProblem.Unwritable });
  assert.equal((await m.choices.choose(empty)).ok, true);
  facts = { kind: DriveKind.Fixed, fileSystem: "FAT32" };
  assert.deepEqual(await m.choices.move(), { ok: false, to: empty, problem: DataFolderProblem.FileSystem });
  assert.equal(m.calls.restarts, 0);
  assert.deepEqual(await readdir(m.defaultDir), ["projects.json"]);
});

test("a build that starts between picking and moving stops the move", async (t) => {
  let busy = false;
  const m = await machine(t, { busy: () => busy });
  const empty = path.join(m.drive, "Genex");
  await mkdir(empty);
  assert.equal((await m.choices.choose(empty)).ok, true);
  busy = true;
  assert.deepEqual(await m.choices.move(), { ok: false, to: empty, problem: DataFolderProblem.Busy });
  assert.equal(m.calls.restarts, 0);
});

test("Storage shows the folder in use and the last move that did not happen, never another launch's", async (t) => {
  const m = await machine(t);
  await writeDataFolderRecord(m.defaultDir, { failed: { to: m.drive, problem: DataFolderProblem.NoSpace } });
  assert.deepEqual(m.choices.state(), {
    dir: m.defaultDir,
    movable: true,
    failed: { to: m.drive, problem: DataFolderProblem.NoSpace },
    kept: [],
  });
  const dev = createDataFolderChoices({ ...m.deps, normal: false });
  assert.deepEqual(dev.state(), { dir: m.defaultDir, movable: false, failed: null, kept: [] });
});

test("a new move forgets the last one's failure and any half-finished entry list", async (t) => {
  const m = await machine(t);
  await writeDataFolderRecord(m.defaultDir, {
    failed: { to: m.drive, problem: DataFolderProblem.InUse },
    moveTo: path.join(m.root, "old-target"),
    moving: ["scratch"],
  });
  const empty = path.join(m.drive, "Genex");
  await mkdir(empty);
  await m.choices.choose(empty);
  await m.choices.move();
  const record = JSON.parse(await readFile(path.join(m.defaultDir, DATA_FOLDER_FILE), "utf8"));
  assert.deepEqual(record, { moveTo: empty });
});

test("a folder on the data's own drive needs no free room: the move only renames", async (t) => {
  const m = await machine(t, { free: async () => 0, sameVolume: async () => true });
  const empty = path.join(m.drive, "Genex");
  await mkdir(empty);
  assert.deepEqual(await m.choices.choose(empty), { ok: true, to: empty, bytes: DATA_BYTES });
});

test("Storage names the old folders that keep files changed after a move", async (t) => {
  const m = await machine(t);
  const old = path.join(m.root, "old");
  await writeDataFolderRecord(m.defaultDir, {
    leftover: [
      { dir: old, entries: ["scratch"], since: 1, changed: true },
      { dir: m.drive, entries: ["runs"], since: 1 },
    ],
  });
  assert.deepEqual(m.choices.state().kept, [old]);
});

test("a folder inside what a move left behind is refused: it would go when that is removed", async (t) => {
  const m = await machine(t);
  const old = path.join(m.root, "old");
  await mkdir(path.join(old, "scratch", "inner"), { recursive: true });
  await writeDataFolderRecord(m.defaultDir, { leftover: [{ dir: old, entries: ["scratch"], since: 1 }] });
  const choice = await m.choices.choose(path.join(old, "scratch", "inner"));
  assert.equal(!choice.ok && choice.problem, DataFolderProblem.Overlaps);
});
