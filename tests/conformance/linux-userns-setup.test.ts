/**
 * Set up on Linux installs Genex's AppArmor profile for the running copy behind one polkit prompt.
 * Driven with a recorded privileged run instead of pkexec: the argv it is handed, what each of
 * pkexec's answers means for the setup screen, and the paths it must refuse before any prompt.
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { InstallExit, appArmorProfile, pkexecArgv, type PathOwner } from "../../src/substrate/linux-apparmor.ts";
import { installLinuxUsernsProfile, type PrivilegedRun } from "../../src/substrate/linux-userns-setup.ts";
import { runningExecutable, sandboxProblem, usernsCheck } from "../../src/substrate/sandbox-unavailable.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY = process.platform === "win32" && "AppArmor paths and symlinks are POSIX";
const PKEXEC = "/usr/bin/pkexec";
const PERSON = { uid: 1000, gid: 1000 };
/** Every path belongs to the person, 0755: a copy Set up may name. */
const OWN_FOLDERS = (): PathOwner => ({ uid: PERSON.uid, gid: PERSON.gid, mode: 0o040755 });

/** A privileged run that answers `result` and records the argv it was given. */
function recorded(result: PrivilegedRun) {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    return result;
  };
  return { calls, run };
}

describe("Set up on Linux", () => {
  const execPath = "/home/ada/Genex portable/genex";
  const seams = { execPath, pkexec: PKEXEC, inspect: OWN_FOLDERS, person: PERSON };

  it("runs pkexec by its absolute path with the profile for the running executable, then asks for a restart", async () => {
    const { calls, run } = recorded({ code: 0, stderr: "" });
    assert.deepEqual(await installLinuxUsernsProfile({ ...seams, run }), { cancelled: false, restart: true });
    const profile = appArmorProfile(execPath);
    assert.ok(profile);
    assert.deepEqual(calls, [pkexecArgv(profile, PKEXEC)]);
  });

  it("a dismissed password prompt (pkexec 126) changes nothing and restarts nothing", async () => {
    const { run } = recorded({ code: 126, stderr: "" });
    assert.deepEqual(await installLinuxUsernsProfile({ ...seams, run }), { cancelled: true, restart: false });
  });

  it("a refusal or a failed install says why", async () => {
    const failures: Array<[PrivilegedRun, RegExp]> = [
      [{ code: 127, stderr: "Error executing command as another user: No authentication agent found." }, /agent/],
      [{ code: InstallExit.NotLoaded, stderr: "AppArmor parser error" }, /refused .*removed again.*parser error/],
      [{ code: InstallExit.NotWritten, stderr: "Read-only file system" }, /could not be written.*Read-only/],
      [{ code: 1, stderr: "something else" }, /failed \(exit 1\)/],
      [{ code: null, stderr: "" }, /did not finish/],
      [{ code: null, stderr: "spawn /usr/bin/pkexec ENOENT", missing: true }, /pkexec.*isn't installed.*terminal/],
    ];
    for (const [result, reason] of failures) {
      const { run } = recorded(result);
      await assert.rejects(installLinuxUsernsProfile({ ...seams, run }), reason);
    }
  });

  it("without pkexec, points to the terminal command and runs nothing", async () => {
    const { calls, run } = recorded({ code: 0, stderr: "" });
    await assert.rejects(installLinuxUsernsProfile({ ...seams, pkexec: null, run }), /isn't installed.*terminal/);
    assert.deepEqual(calls, []);
  });

  it("refuses a folder a profile cannot name, before asking for any password", async () => {
    for (const unnamable of ["/home/ada/Genex [old]/genex", "relative/genex", "/opt/a\nb/genex"]) {
      const { calls, run } = recorded({ code: 0, stderr: "" });
      await assert.rejects(installLinuxUsernsProfile({ ...seams, execPath: unnamable, run }), /cannot be named/);
      assert.deepEqual(calls, [], JSON.stringify(unnamable));
    }
  });
});

describe("Set up refuses a copy others could replace, before any prompt", { skip: POSIX_ONLY }, () => {
  it("on this machine's shared folders: /tmp, /var/tmp and /dev/shm", async () => {
    for (const shared of ["/tmp", "/var/tmp", "/dev/shm"]) {
      const { calls, run } = recorded({ code: 0, stderr: "" });
      const execPath = `${shared}/Genex/genex`;
      await assert.rejects(installLinuxUsernsProfile({ execPath, pkexec: PKEXEC, run }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Someone other than root and you can change/);
        assert.ok(error.message.includes(JSON.stringify(shared)), error.message);
        return true;
      });
      assert.deepEqual(calls, [], shared);
    }
  });

  it("in a folder another group may write, or another person owns", async () => {
    const cases: Array<[string, PathOwner]> = [
      ["group-writable by another group", { uid: PERSON.uid, gid: 100, mode: 0o040775 }],
      ["owned by another person", { uid: 1001, gid: 1001, mode: 0o040755 }],
      ["world-writable and sticky", { uid: 0, gid: 0, mode: 0o041777 }],
    ];
    for (const [name, sharedFolder] of cases) {
      const inspect = (file: string) => (file === "/srv/team" ? sharedFolder : OWN_FOLDERS());
      const { calls, run } = recorded({ code: 0, stderr: "" });
      const execPath = "/srv/team/Genex/genex";
      await assert.rejects(
        installLinuxUsernsProfile({ execPath, pkexec: PKEXEC, inspect, person: PERSON, run }),
        /"\/srv\/team"/,
        name,
      );
      assert.deepEqual(calls, [], name);
      const problem = sandboxProblem({
        platform: StudioPlatform.Linux,
        supported: true,
        dependencyErrors: [],
        missingTools: [],
        userns: usernsCheck({ execPath, inspect, person: PERSON, read: () => null }),
      });
      assert.equal(problem?.apparmor, undefined, `${name}: the screen offers no Set up and no command`);
    }
  });
});

describe("the running executable, resolved", { skip: POSIX_ONLY }, () => {
  it("follows a link to its target and keeps a dangling link as it is", async () => {
    const root = await tmpDir("genex-exec-");
    const target = path.join(root, "Genex", "genex");
    await mkdir(path.dirname(target));
    await writeFile(target, "");
    const link = path.join(root, "genex-link");
    await symlink(target, link);
    const dangling = path.join(root, "dangling");
    await symlink(path.join(root, "gone"), dangling);
    assert.equal(runningExecutable(link), realpathSync(target));
    assert.equal(runningExecutable(dangling), dangling);
  });

  it("a link into a folder a profile cannot name offers no profile and asks for no password", async () => {
    const root = await tmpDir("genex-exec-");
    const target = path.join(root, "Genex [old]", "genex");
    await mkdir(path.dirname(target));
    await writeFile(target, "");
    const execPath = path.join(root, "genex");
    await symlink(target, execPath);
    const check = usernsCheck({ execPath, inspect: OWN_FOLDERS, person: PERSON, read: () => null });
    assert.equal(check.executable, realpathSync(target));
    const problem = sandboxProblem({
      platform: StudioPlatform.Linux,
      supported: true,
      dependencyErrors: [],
      missingTools: [],
      userns: check,
    });
    assert.equal(problem?.apparmor, undefined);
    const { calls, run } = recorded({ code: 0, stderr: "" });
    await assert.rejects(
      installLinuxUsernsProfile({ execPath, pkexec: PKEXEC, inspect: OWN_FOLDERS, person: PERSON, run }),
      /cannot be named/,
    );
    assert.deepEqual(calls, []);
  });
});
