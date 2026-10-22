/**
 * Genex's data on another Windows drive, for real: what Windows says about a drive, a new folder
 * locked down to the profile's access, a move across drives whose build copies still work, and
 * the sandbox inside a moved data folder (its granted folders work, everything else in it stays
 * closed, the secrets included). The parsers run everywhere; the rest on Windows, the sandbox part
 * only where it is provisioned (the Windows CI job sets GENEX_WINDOWS_SANDBOX=ready), and the
 * move only where a second drive exists (a hosted runner's D:).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { runDataMove } from "../../src/main/data-move-launch.ts";
import { readDataFolderRecord, writeDataFolderRecord } from "../../src/main/data-folder.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import {
  DriveKind,
  driveOf,
  isSharePath,
  keepsPermissions,
  lockDownArgs,
  lockDownFolder,
  parseDriveFacts,
  parseUserSid,
  systemTool,
  windowsDriveFacts,
} from "../../src/substrate/windows-drive.ts";
import { gitFile } from "../helpers/git.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const WINDOWS = process.platform === "win32";
const SANDBOX_READY = WINDOWS && process.env.GENEX_WINDOWS_SANDBOX === "ready";
const SECRET = "data-folder-secret";
const TEST_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 60_000;

describe("what Windows says about a drive", () => {
  it("reads a drive's kind and file system from CIM's JSON", () => {
    assert.deepEqual(parseDriveFacts('{"DriveType":3,"FileSystem":"NTFS"}'), {
      kind: DriveKind.Fixed,
      fileSystem: "NTFS",
    });
    assert.deepEqual(parseDriveFacts('{"DriveType":2,"FileSystem":"exFAT"}'), {
      kind: DriveKind.Removable,
      fileSystem: "exFAT",
    });
    assert.equal(parseDriveFacts('{"DriveType":4,"FileSystem":null}')?.kind, DriveKind.Network);
    assert.equal(parseDriveFacts('{"DriveType":5,"FileSystem":"CDFS"}')?.kind, DriveKind.Other);
    for (const garbled of ["", "null", "not json", '{"FileSystem":"NTFS"}'])
      assert.equal(parseDriveFacts(garbled), null);
  });

  it("keeps permissions only on NTFS and ReFS", () => {
    for (const [fileSystem, keeps] of [
      ["NTFS", true],
      ["ReFS", true],
      ["exFAT", false],
      ["FAT32", false],
      ["", false],
    ] as const)
      assert.equal(keepsPermissions({ kind: DriveKind.Fixed, fileSystem }), keeps, fileSystem);
  });

  it("knows a drive letter from a share", () => {
    assert.equal(driveOf("d:\\Games\\Genex"), "D:");
    assert.equal(driveOf("\\\\server\\share\\Genex"), null);
    assert.equal(isSharePath("\\\\server\\share\\Genex"), true);
    assert.equal(isSharePath("//server/share"), true);
    assert.equal(isSharePath("\\\\?\\UNC\\server\\share"), true);
    assert.equal(isSharePath("\\\\?\\D:\\Genex"), false);
    assert.equal(isSharePath("D:\\Genex"), false);
  });

  it("names this account by its SID and grants only it, LocalSystem and Administrators", () => {
    const sid = "S-1-5-21-111-222-333-1001";
    assert.equal(parseUserSid(`"desktop-1\\\\ann","${sid}"\r\n`), sid);
    assert.equal(parseUserSid('"AzureAD\\\\Ann","S-1-12-1-1-2-3-4"'), "S-1-12-1-1-2-3-4");
    assert.equal(parseUserSid("ERROR: no user"), null);
    assert.deepEqual(lockDownArgs("D:\\Genex", sid), [
      "D:\\Genex",
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
      "/q",
    ]);
  });
});

/** A path's own DACL as SDDL, read through icacls, which saves it without changing anything. */
function sddl(target: string): string {
  const file = path.join(os.tmpdir(), `genex-acl-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  execFileSync("icacls", [target, "/save", file], { stdio: "ignore" });
  const text = readFileSync(file, "utf16le");
  rmSync(file, { force: true });
  return text;
}

/** SDDL's names for the groups a second drive's root lets in: Authenticated Users, Users, Everyone. */
const OPEN_TO_ALL = /;;;(AU|BU|WD)\)/;

/** A drive other than the temp folder's, where a hosted runner has one. */
function secondDrive(): string | null {
  if (!WINDOWS) return null;
  const temp = statSync(os.tmpdir()).dev;
  for (const letter of ["D", "E"]) {
    const root = `${letter}:\\`;
    if (existsSync(root) && statSync(root).dev !== temp) return root;
  }
  return null;
}
const SECOND = secondDrive();
const made: string[] = [];
after(async () => {
  for (const dir of made) await removeTree(dir);
});

/** A folder on the second drive, removed after the file. */
async function onSecondDrive(name: string): Promise<string> {
  const dir = path.join(SECOND ?? os.tmpdir(), `genex-data-${name}-${process.pid}`);
  await mkdir(dir, { recursive: true });
  made.push(dir);
  return dir;
}

describe("a folder for Genex's data on Windows", {
  skip: WINDOWS ? false : "Windows only",
  timeout: TEST_TIMEOUT_MS,
}, () => {
  it("describes the system drive as a fixed NTFS drive", async () => {
    const facts = await windowsDriveFacts(process.env.SystemDrive ? `${process.env.SystemDrive}\\` : "C:\\");
    assert.deepEqual(facts, { kind: DriveKind.Fixed, fileSystem: "NTFS" });
  });

  it("locks a new folder down to this account, LocalSystem and Administrators, inheriting nothing", async () => {
    const dir = path.join(realpathSync.native(await tmpDir("genex-lockdown-")), "Genex");
    await mkdir(dir);
    await lockDownFolder(dir);
    const acl = sddl(dir);
    assert.match(acl, /D:P/, "protected: nothing inherited from the drive");
    assert.doesNotMatch(acl, OPEN_TO_ALL, "no group of every signed-in user");
    assert.match(acl, /;;;SY\)/);
    assert.match(acl, /;;;BA\)/);
    await writeFile(path.join(dir, "inside.txt"), "x");
    assert.doesNotMatch(sddl(path.join(dir, "inside.txt")), OPEN_TO_ALL, "files made in it inherit only that");
    assert.equal(ownerSid(dir), thisAccountSid(), "owned by this account, which alone may open it again");
  });
});

/** This account's SID, from System32's own whoami. */
function thisAccountSid(): string {
  return (
    parseUserSid(execFileSync(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" })) ?? ""
  );
}

/** The owner of `target` as a SID, from Windows PowerShell's Get-Acl. */
function ownerSid(target: string): string {
  const script = `(Get-Acl -LiteralPath '${target.replaceAll("'", "''")}').GetOwner([System.Security.Principal.SecurityIdentifier]).Value`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  }).trim();
}

describe("moving Genex's data to a second drive", {
  skip: SECOND ? false : "needs a second drive",
  timeout: TEST_TIMEOUT_MS,
}, () => {
  it("copies across drives, keeps the copies closed and leaves every build copy working", async () => {
    const root = realpathSync.native(await tmpDir("genex-move-"));
    const from = path.join(root, "Genex");
    const game = path.join(root, "AI Games", "Racer");
    const runCopy = path.join(from, "scratch", "autopilot", "run-1");
    await mkdir(game, { recursive: true });
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    };
    await gitFile(["-C", game, "init", "-q"], { env });
    await writeFile(path.join(game, "main.js"), "1\n");
    await gitFile(["-C", game, "add", "-A"], { env });
    await gitFile(["-C", game, "commit", "-q", "-m", "first"], { env });
    await mkdir(path.dirname(runCopy), { recursive: true });
    await gitFile(["-C", game, "worktree", "add", "-q", "--detach", runCopy], { env });
    await mkdir(path.join(from, "secrets"), { recursive: true });
    await writeFile(path.join(from, "secrets", "token"), SECRET);
    // A build shadow's node_modules linked to a game Genex keeps a copy of, inside its data.
    const keptModules = path.join(from, "opened-copies", "Puzzle", "node_modules");
    await mkdir(keptModules, { recursive: true });
    await mkdir(path.join(from, "scratch", "builds", "puzzle-1"), { recursive: true });
    await symlink(keptModules, path.join(from, "scratch", "builds", "puzzle-1", "node_modules"), "junction");
    const to = path.join(await onSecondDrive("move"), "Genex");
    await mkdir(to);
    await lockDownFolder(to);
    await writeDataFolderRecord(from, { moveTo: to });

    const outcome = await runDataMove({ from, to, defaultDir: from, progress: () => {}, log: () => {} });
    assert.deepEqual(outcome, { moved: true, mode: "copied" });
    assert.deepEqual(readDataFolderRecord(from), { dir: to });
    assert.equal(await readFile(path.join(to, "secrets", "token"), "utf8"), SECRET);
    assert.doesNotMatch(sddl(path.join(to, "secrets", "token")), OPEN_TO_ALL, "a copy on the new drive stays closed");
    const moved = path.join(to, "scratch", "autopilot", "run-1");
    const { stdout } = await gitFile(["-C", moved, "status", "--porcelain"]);
    assert.equal(String(stdout), "");
    assert.equal(existsSync(runCopy), false, "the original is gone");
    const link = await readlink(path.join(to, "scratch", "builds", "puzzle-1", "node_modules"));
    assert.equal(
      path.resolve(link).toLowerCase(),
      path.join(to, "opened-copies", "Puzzle", "node_modules").toLowerCase(),
    );
  });
});

describe("the sandbox in a data folder on a second drive", {
  skip: SANDBOX_READY && SECOND ? false : "needs a provisioned sandbox and a second drive",
  timeout: TEST_TIMEOUT_MS,
}, () => {
  it("writes the folders it is granted and reads nothing else of Genex's data, the secrets included", async () => {
    const data = path.join(await onSecondDrive("sandbox"), "Genex");
    await mkdir(data);
    await lockDownFolder(data);
    const workspaces = path.join(data, "workspaces");
    const scratch = path.join(data, "scratch");
    const secrets = path.join(data, "secrets");
    const events = path.join(data, "exoharness");
    for (const dir of [workspaces, scratch, secrets, events]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(secrets, "token"), SECRET);
    await writeFile(path.join(events, "events.jsonl"), SECRET);
    const sandbox = await ProcessSandbox.create({
      writableRoots: [workspaces],
      scratchDir: scratch,
      secretPaths: [secrets],
      dataRoot: data,
    });
    try {
      const run = (command: string) => sandbox.run({ command, cwd: workspaces, timeoutMs: RUN_TIMEOUT_MS });
      const wrote = await run('printf built > artifact.txt && printf tmp > "$TMPDIR/probe.txt" && pwd -P');
      assert.equal(wrote.code, 0, wrote.stderr);
      assert.equal(await readFile(path.join(workspaces, "artifact.txt"), "utf8"), "built");
      assert.equal(await readFile(path.join(scratch, "probe.txt"), "utf8"), "tmp");
      const q = (file: string) => `'${file.replaceAll("\\", "/")}'`;
      for (const file of [path.join(secrets, "token"), path.join(events, "events.jsonl")]) {
        const read = await run(`cat ${q(file)}`);
        assert.notEqual(read.code, 0, `${file} must not be readable`);
        assert.ok(!read.stdout.includes(SECRET), `${file} leaked`);
      }
      const escaped = path.join(data, "escaped.txt");
      const write = await run(`printf x > ${q(escaped)}`);
      assert.notEqual(write.code, 0);
      assert.equal(existsSync(escaped), false, "the data folder's own top is not writable");
    } finally {
      await sandbox.dispose();
    }
  });
});

describe("Windows' own tools", () => {
  it("are run from System32, never whatever look-alike PATH finds first (Git's whoami)", () => {
    assert.equal(systemTool("whoami.exe", { SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\whoami.exe");
    assert.equal(systemTool("icacls.exe", { SYSTEMROOT: "D:\\Win" }), "D:\\Win\\System32\\icacls.exe");
    assert.equal(systemTool("icacls.exe", {}), "C:\\Windows\\System32\\icacls.exe");
  });
});
