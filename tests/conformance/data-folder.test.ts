/**
 * Where a launch keeps Genex's data. The default folder holds a record when the person moved the
 * data (Settings → Storage); the launch follows it before anything reads userData. Only the
 * person's own launch moves the data or waits for a missing folder: runner, developer and
 * installer launches follow a finished move and never start one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DATA_FOLDER_FILE,
  DATA_MOVE_SESSION,
  type DataFolderRecord,
  type DataLaunch,
  dataLaunchFor,
  DataLaunchKind,
  parseDataFolderRecord,
  pointElectronAtData,
  quitsAtOnce,
  quitTakenLaunch,
  readDataFolderRecord,
  thisDataLaunch,
  writeDataFolderRecord,
} from "../../src/main/data-folder.ts";
import { isNormalLaunch, StudioFlag } from "../../src/main/dev/launch-flags.ts";
import { DataFolderProblem } from "../../src/shared/data-folder.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const DEFAULT = path.resolve("/data/Genex");
const CHOSEN = path.resolve("/drive/Genex");
const NEXT = path.resolve("/other/Genex");

/** Each row: the record, whether the launch is the person's own, which folders exist, and the decision. */
const DECISIONS: Array<{
  name: string;
  record: DataFolderRecord;
  normal: boolean;
  there: string[];
  launch: DataLaunch;
}> = [
  { name: "no record", record: {}, normal: true, there: [], launch: { kind: DataLaunchKind.Default, dir: DEFAULT } },
  {
    name: "a chosen folder that is there",
    record: { dir: CHOSEN },
    normal: true,
    there: [CHOSEN],
    launch: { kind: DataLaunchKind.Moved, dir: CHOSEN },
  },
  {
    name: "a chosen folder on a drive that is gone",
    record: { dir: CHOSEN },
    normal: true,
    there: [],
    launch: { kind: DataLaunchKind.Missing, dir: CHOSEN },
  },
  {
    name: "a move out of the default folder",
    record: { moveTo: CHOSEN },
    normal: true,
    there: [DEFAULT, CHOSEN],
    launch: { kind: DataLaunchKind.Move, from: DEFAULT, to: CHOSEN },
  },
  {
    name: "a move from one chosen folder to another",
    record: { dir: CHOSEN, moveTo: NEXT },
    normal: true,
    there: [CHOSEN, NEXT],
    launch: { kind: DataLaunchKind.Move, from: CHOSEN, to: NEXT },
  },
  {
    name: "a move back into the default folder",
    record: { dir: CHOSEN, moveTo: DEFAULT },
    normal: true,
    there: [CHOSEN, DEFAULT],
    launch: { kind: DataLaunchKind.Move, from: CHOSEN, to: DEFAULT },
  },
  {
    name: "a move out of a folder that is gone waits for it",
    record: { dir: CHOSEN, moveTo: NEXT },
    normal: true,
    there: [NEXT],
    launch: { kind: DataLaunchKind.Missing, dir: CHOSEN },
  },
  {
    name: "a move to the folder already in use is no move",
    record: { dir: CHOSEN, moveTo: CHOSEN },
    normal: true,
    there: [CHOSEN],
    launch: { kind: DataLaunchKind.Moved, dir: CHOSEN },
  },
  {
    name: "a runner's launch follows a finished move",
    record: { dir: CHOSEN },
    normal: false,
    there: [CHOSEN],
    launch: { kind: DataLaunchKind.Moved, dir: CHOSEN },
  },
  {
    name: "a runner's launch never makes a move",
    record: { dir: CHOSEN, moveTo: NEXT },
    normal: false,
    there: [CHOSEN, NEXT],
    launch: { kind: DataLaunchKind.Moved, dir: CHOSEN },
  },
  {
    name: "a runner's launch never waits for a missing folder",
    record: { dir: CHOSEN },
    normal: false,
    there: [],
    launch: { kind: DataLaunchKind.Default, dir: DEFAULT },
  },
];

for (const row of DECISIONS) {
  test(`a launch decides its data folder: ${row.name}`, () => {
    const there = new Set(row.there);
    const launch = dataLaunchFor(row.record, {
      defaultDir: DEFAULT,
      normal: row.normal,
      exists: (dir) => there.has(dir),
    });
    assert.deepEqual(launch, row.launch);
  });
}

test("a record keeps only absolute folders and problems it knows", () => {
  assert.deepEqual(
    parseDataFolderRecord({
      dir: "relative/Genex",
      moveTo: CHOSEN,
      leftover: 7,
      failed: { to: NEXT, problem: "made-up" },
    }),
    { moveTo: CHOSEN },
  );
  assert.deepEqual(parseDataFolderRecord({ failed: { to: NEXT, problem: DataFolderProblem.NoSpace } }), {
    failed: { to: NEXT, problem: DataFolderProblem.NoSpace },
  });
  for (const raw of [null, "dir", 3, [CHOSEN]]) assert.deepEqual(parseDataFolderRecord(raw), {});
});

test("a record that is missing or unreadable is the default folder", async (t) => {
  const dir = await tmpDir("data-folder-");
  t.after(() => removeTree(dir));
  assert.deepEqual(readDataFolderRecord(dir), {});
  await writeFile(path.join(dir, DATA_FOLDER_FILE), "{ not json");
  assert.deepEqual(readDataFolderRecord(dir), {});
  await writeDataFolderRecord(dir, { dir: CHOSEN });
  assert.deepEqual(readDataFolderRecord(dir), { dir: CHOSEN });
});

test("only the person's own launch is normal: runners, developers and the installer are not", () => {
  assert.equal(isNormalLaunch(["Genex.exe"]), true);
  assert.equal(isNormalLaunch(["Genex.exe", "--squirrel-firstrun"]), false);
  assert.equal(isNormalLaunch(["Genex.exe", StudioFlag.Smoke]), false);
  assert.equal(isNormalLaunch(["Genex.exe", `${StudioFlag.DevLaunch}=/x/launch.json`]), false);
});

/** Electron's paths as boot.ts sees them, in a test folder, recording what it is pointed at. */
async function electronHost(t: { after(fn: () => Promise<void>): void }, argvNormal = true) {
  const root = await realpath(await tmpDir("data-boot-"));
  t.after(() => removeTree(root));
  const appData = path.join(root, "AppData");
  const temp = path.join(root, "Temp");
  await mkdir(path.join(appData, "Genex"), { recursive: true });
  await mkdir(temp);
  const set: Record<string, string> = {};
  const calls: string[] = [];
  let locks = true;
  return {
    root,
    defaultDir: path.join(appData, "Genex"),
    host: {
      appData,
      appName: "Genex",
      temp,
      argvNormal,
      setPath: (name: string, dir: string) => {
        set[name] = dir;
        calls.push(`${name}=${dir}`);
      },
      lock: () => {
        calls.push(`lock in ${set.userData ?? "default"}`);
        return locks;
      },
    },
    set,
    calls,
    refuseLock: () => {
      locks = false;
    },
  };
}

test("boot points Electron at the chosen folder, and at a temp folder of its own while it moves the data", async (t) => {
  const { root, defaultDir, host, set } = await electronHost(t);
  assert.deepEqual(pointElectronAtData(host), { kind: DataLaunchKind.Default, dir: defaultDir });
  assert.deepEqual(set, {}, "the default folder needs no change");

  const chosen = path.join(root, "D", "Genex");
  await mkdir(chosen, { recursive: true });
  await writeDataFolderRecord(defaultDir, { dir: chosen });
  assert.deepEqual(pointElectronAtData(host), { kind: DataLaunchKind.Moved, dir: chosen });
  assert.deepEqual(set, { userData: chosen, sessionData: chosen });
  assert.deepEqual(
    thisDataLaunch(defaultDir),
    { kind: DataLaunchKind.Moved, dir: chosen },
    "the app bundle reads it back",
  );

  await writeDataFolderRecord(defaultDir, { dir: chosen, moveTo: path.join(root, "E", "Genex") });
  pointElectronAtData(host);
  const session = path.join(host.temp, DATA_MOVE_SESSION);
  assert.deepEqual(set, { userData: session, sessionData: session });
  assert.equal(
    JSON.parse(await readFile(path.join(defaultDir, DATA_FOLDER_FILE), "utf8")).moveTo,
    path.join(root, "E", "Genex"),
  );
});

test("a chosen folder Electron cannot use is a missing one, never an empty default", async (t) => {
  const { root, defaultDir, host, set } = await electronHost(t);
  const chosen = path.join(root, "D", "Genex");
  await mkdir(chosen, { recursive: true });
  await writeDataFolderRecord(defaultDir, { dir: chosen });
  const refusing = {
    ...host,
    setPath: (name: string, dir: string) => {
      if (dir === chosen) throw new Error("Failed to set path");
      set[name] = dir;
    },
  };
  assert.deepEqual(pointElectronAtData(refusing), { kind: DataLaunchKind.Missing, dir: chosen });
  assert.equal(set.userData, path.join(host.temp, DATA_MOVE_SESSION));
});

test("on Windows a move to the folder already in use, spelled in another case, is no move", {
  skip: process.platform !== "win32" && "Windows reads names in any case",
}, () => {
  const launch = dataLaunchFor(
    { dir: "D:\\Genex", moveTo: "d:\\genex" },
    { defaultDir: "C:\\Users\\Ann\\AppData\\Roaming\\Genex", normal: true, exists: () => true },
  );
  assert.deepEqual(launch, { kind: DataLaunchKind.Moved, dir: "D:\\Genex" });
});

test("a move takes Genex's one-instance lock in the folder it moves out of, before anything else", async (t) => {
  const { root, defaultDir, host, calls } = await electronHost(t);
  const chosen = path.join(root, "D", "Genex");
  await mkdir(chosen, { recursive: true });
  await writeDataFolderRecord(defaultDir, { dir: chosen, moveTo: path.join(root, "E", "Genex") });
  assert.equal(pointElectronAtData(host).kind, DataLaunchKind.Move);
  const session = path.join(host.temp, DATA_MOVE_SESSION);
  assert.deepEqual(calls, [`userData=${chosen}`, `lock in ${chosen}`, `userData=${session}`, `sessionData=${session}`]);
});

test("a move while another Genex runs on the data only wakes that one: nothing moves", async (t) => {
  const { root, defaultDir, host, set, refuseLock } = await electronHost(t);
  await writeDataFolderRecord(defaultDir, { moveTo: path.join(root, "D", "Genex") });
  refuseLock();
  assert.deepEqual(pointElectronAtData(host), { kind: DataLaunchKind.Taken, dir: defaultDir });
  assert.equal(set.userData, path.join(host.temp, DATA_MOVE_SESSION), "Electron's own files stay out of both folders");
  assert.deepEqual(readDataFolderRecord(defaultDir), { moveTo: path.join(root, "D", "Genex") }, "the move waits");
});

test("a launch whose move is taken by a running Genex only quits; every other launch goes on", () => {
  assert.equal(quitsAtOnce({ kind: DataLaunchKind.Taken, dir: DEFAULT }), true);
  for (const launch of [
    { kind: DataLaunchKind.Default, dir: DEFAULT },
    { kind: DataLaunchKind.Moved, dir: CHOSEN },
    { kind: DataLaunchKind.Move, from: DEFAULT, to: CHOSEN },
    { kind: DataLaunchKind.Missing, dir: CHOSEN },
  ] as const)
    assert.equal(quitsAtOnce(launch), false, launch.kind);
});

test("a launch whose data another Genex holds says so in one line, then quits", async () => {
  const seen: string[] = [];
  await quitTakenLaunch({
    ready: async () => {
      seen.push("ready");
    },
    tell: async (message, button) => {
      seen.push(`${message} [${button}]`);
    },
    exit: (code) => seen.push(`exit ${code}`),
  });
  assert.deepEqual(seen, ["ready", "Genex is already open, or its data folder is locked. [OK]", "exit 0"]);
});
