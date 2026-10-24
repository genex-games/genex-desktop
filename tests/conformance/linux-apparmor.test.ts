/**
 * Ubuntu 23.10 and later give an unconfined program no capabilities in a new user namespace, which
 * Chromium's sandbox and bubblewrap (Genex's process sandbox) need. Genex's fix is one AppArmor
 * profile, written by one function: the deb and rpm maintainer scripts install it for the
 * packaged executable, and the setup screen installs it for any other copy (pkexec, or the same
 * command by hand). These tests drive that function, the restriction check, and the generated
 * shell (run with `sh` against a temporary AppArmor folder and a recording `apparmor_parser`).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  AppArmorProfileName,
  APPARMOR_LABEL_FILES,
  CHROMIUM_SANDBOX_FATALS,
  InstallExit,
  LINUX_PACKAGED_EXECUTABLE,
  LinuxPackageScript,
  ProfilePathRefusal,
  USERNS_RESTRICTION_FILE,
  appArmorProfile,
  linuxPackageScriptFiles,
  linuxPackageScripts,
  pkexecArgv,
  portableInstallScript,
  portableReadme,
  profileInstallArgv,
  profileInstallCommand,
  profilePathRefusal,
  profileRemoveCommand,
  usernsRestricted,
  withFollowing,
  writableByOthers,
  writeLinuxPackageScripts,
  type AppArmorSystem,
  type PathOwner,
} from "../../src/substrate/linux-apparmor.ts";
import {
  type AppExit,
  checkUnprofiledCopy,
  type LaunchApp,
  UNPROFILED_EXIT_TIMEOUT_MS,
  UnprofiledFailure,
} from "../../scripts/ci-linux-userns.ts";
import { currentPerson, inspectPath } from "../../src/substrate/sandbox-unavailable.ts";
import { tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, "../..");
const POSIX_ONLY = process.platform === "win32" && "the generated scripts are POSIX shell, run on Linux";

/** The profile Ubuntu ships for VS Code, with Genex's name and path in it. */
const PACKAGED_PROFILE = [
  "# Genex: lets Genex and the programs it starts create user namespaces under the Ubuntu",
  "# AppArmor restriction, as Chromium and bubblewrap sandboxes need. It confines nothing.",
  "abi <abi/4.0>,",
  "include <tunables/global>",
  "",
  "profile genex /usr/lib/genex/genex flags=(unconfined) {",
  "  userns,",
  "",
  "  # Site-specific additions and overrides. See local/README for details.",
  "  include if exists <local/genex>",
  "}",
].join("\n");

describe("Genex's AppArmor profile", () => {
  it("names the packaged executable as Ubuntu's own profiles do: unconfined, userns and a local include", () => {
    assert.deepEqual(appArmorProfile(LINUX_PACKAGED_EXECUTABLE), {
      name: AppArmorProfileName.Packaged,
      executable: LINUX_PACKAGED_EXECUTABLE,
      file: "/etc/apparmor.d/genex",
      text: PACKAGED_PROFILE,
    });
  });

  it("gives any other copy the portable profile, quoting a path that is not plain", () => {
    const cases: Array<[string, string]> = [
      ["/home/ada/Genex-linux-x64/genex", "/home/ada/Genex-linux-x64/genex"],
      ["/home/ada/Genex portable/genex", '"/home/ada/Genex portable/genex"'],
      ["/opt/Genex (1)/genex", '"/opt/Genex (1)/genex"'],
      ["/home/ada/it's mine/genex", `"/home/ada/it's mine/genex"`],
      ["/home/иван/Genex/genex", '"/home/иван/Genex/genex"'],
      ["/opt/a,b#c/genex", '"/opt/a,b#c/genex"'],
    ];
    for (const [executable, attachment] of cases) {
      const profile = appArmorProfile(executable);
      assert.ok(profile, executable);
      assert.equal(profile.name, AppArmorProfileName.Portable);
      assert.equal(profile.file, "/etc/apparmor.d/genex-portable");
      assert.ok(
        profile.text.includes(`\nprofile genex-portable ${attachment} flags=(unconfined) {\n  userns,\n`),
        executable,
      );
      assert.ok(profile.text.includes("\n  include if exists <local/genex-portable>\n}"), executable);
    }
  });

  it("refuses a path AppArmor would read as a pattern, or cannot name", () => {
    const cases: Array<[string, ProfilePathRefusal]> = [
      ["genex", ProfilePathRefusal.NotAbsolute],
      ["./genex", ProfilePathRefusal.NotAbsolute],
      ["/opt//genex", ProfilePathRefusal.NotNormalized],
      ["/opt/./genex", ProfilePathRefusal.NotNormalized],
      ["/opt/../genex", ProfilePathRefusal.NotNormalized],
      ["/opt/genex/", ProfilePathRefusal.NotNormalized],
      ["/opt/gen*ex/genex", ProfilePathRefusal.Pattern],
      ["/opt/a?b/genex", ProfilePathRefusal.Pattern],
      ["/opt/[x]/genex", ProfilePathRefusal.Pattern],
      ["/opt/{a,b}/genex", ProfilePathRefusal.Pattern],
      ["/opt/a^b/genex", ProfilePathRefusal.Pattern],
      ["/opt/@{HOME}/genex", ProfilePathRefusal.Pattern],
      ['/opt/a"b/genex', ProfilePathRefusal.Pattern],
      ["/opt/a\\b/genex", ProfilePathRefusal.Pattern],
      ["/opt/a\nb/genex", ProfilePathRefusal.Control],
      ["/opt/a\tb/genex", ProfilePathRefusal.Control],
      ["/opt/a\u0000b/genex", ProfilePathRefusal.Control],
      ["/opt/a\u007fb/genex", ProfilePathRefusal.Control],
    ];
    for (const [executable, refusal] of cases) {
      assert.equal(profilePathRefusal(executable), refusal, JSON.stringify(executable));
      assert.equal(appArmorProfile(executable), null, JSON.stringify(executable));
    }
    assert.equal(profilePathRefusal(LINUX_PACKAGED_EXECUTABLE), null);
  });
});

describe("Ubuntu's user-namespace restriction", () => {
  const [AA_LABEL, LSM_LABEL] = APPARMOR_LABEL_FILES;
  /** A reader over `files`; a file that is not listed cannot be read. */
  const reads = (files: Record<string, string>) => (file: string) => files[file] ?? null;

  it("applies only when the switch is 1 and no profile labels this process", () => {
    const cases: Array<[string, Record<string, string>, boolean]> = [
      ["a kernel without the switch (Ubuntu 22.04, Fedora)", { [AA_LABEL]: "unconfined\n" }, false],
      ["the switch off", { [USERNS_RESTRICTION_FILE]: "0\n", [AA_LABEL]: "unconfined\n" }, false],
      ["the switch on, unconfined", { [USERNS_RESTRICTION_FILE]: "1\n", [AA_LABEL]: "unconfined\n" }, true],
      [
        "the switch on, under Genex's profile",
        { [USERNS_RESTRICTION_FILE]: "1\n", [AA_LABEL]: "genex (unconfined)\n" },
        false,
      ],
      [
        "the switch on, under another profile (VS Code's terminal)",
        { [USERNS_RESTRICTION_FILE]: "1\n", [AA_LABEL]: "vscode (unconfined)\n" },
        false,
      ],
      [
        "only the classic label file (no LSM stacking)",
        { [USERNS_RESTRICTION_FILE]: "1", [LSM_LABEL]: "unconfined\u0000" },
        true,
      ],
      [
        "the AppArmor label wins over the classic one",
        { [USERNS_RESTRICTION_FILE]: "1", [AA_LABEL]: "genex (unconfined)", [LSM_LABEL]: "unconfined" },
        false,
      ],
      [
        "the switch on, under Ubuntu's unprivileged_userns (a toolbox or rootless-container shell)",
        { [USERNS_RESTRICTION_FILE]: "1\n", [AA_LABEL]: "unprivileged_userns\n" },
        true,
      ],
      [
        "the same with its mode",
        { [USERNS_RESTRICTION_FILE]: "1\n", [AA_LABEL]: "unprivileged_userns (enforce)\n" },
        true,
      ],
      [
        "a stack that holds unprivileged_userns",
        { [USERNS_RESTRICTION_FILE]: "1\n", [AA_LABEL]: "genex-portable//&unprivileged_userns (mixed)\n" },
        true,
      ],
      [
        "a profile whose name only starts with it",
        { [USERNS_RESTRICTION_FILE]: "1\n", [AA_LABEL]: "unprivileged_userns_helper (enforce)\n" },
        false,
      ],
      ["the switch on, no label readable (nothing a profile could change)", { [USERNS_RESTRICTION_FILE]: "1" }, false],
      ["a value that is not 1", { [USERNS_RESTRICTION_FILE]: "2\n", [AA_LABEL]: "unconfined" }, false],
      ["no files at all (not Linux)", {}, false],
    ];
    for (const [name, files, restricted] of cases) assert.equal(usernsRestricted(reads(files)), restricted, name);
  });
});

describe("a folder only root and the person can change", () => {
  const PERSON = { uid: 1000, gid: 1000 };
  const DIR = 0o040000;
  const FILE = 0o100000;
  const own = (mode: number): PathOwner => ({ uid: PERSON.uid, gid: PERSON.gid, mode });
  const root = (mode: number): PathOwner => ({ uid: 0, gid: 0, mode });
  /** Every path root-owned 0755 up to /home, the person's own below, except the `overrides`. */
  const tree =
    (overrides: Record<string, PathOwner | null> = {}) =>
    (file: string): PathOwner | null => {
      if (file in overrides) return overrides[file] ?? null;
      return file === "/" || file === "/home"
        ? root(DIR | 0o755)
        : own(file.endsWith("/genex") ? FILE | 0o755 : DIR | 0o755);
    };
  const EXECUTABLE = "/home/ada/Genex/genex";

  it("accepts a copy in the person's own folders, including ones their own group may write (Ubuntu's umask)", () => {
    assert.equal(writableByOthers(EXECUTABLE, tree(), PERSON), null);
    assert.equal(writableByOthers(EXECUTABLE, tree({ "/home/ada/Genex": own(DIR | 0o775) }), PERSON), null);
    assert.equal(
      writableByOthers(LINUX_PACKAGED_EXECUTABLE, () => root(DIR | 0o755), PERSON),
      null,
    );
  });

  it("names the first path someone else could replace", () => {
    const cases: Array<[string, Record<string, PathOwner | null>, string]> = [
      ["a sticky, world-writable folder (/tmp)", { "/home": root(DIR | 0o1777) }, "/home"],
      ["a world-writable folder", { "/home/ada/Genex": own(DIR | 0o777) }, "/home/ada/Genex"],
      [
        "a folder another group may write",
        { "/home/ada/Genex": { uid: PERSON.uid, gid: 100, mode: DIR | 0o775 } },
        "/home/ada/Genex",
      ],
      ["a folder another person owns", { "/home/ada": { uid: 1001, gid: 1001, mode: DIR | 0o755 } }, "/home/ada"],
      ["a world-writable executable", { [EXECUTABLE]: own(FILE | 0o777) }, EXECUTABLE],
      ["a path that cannot be read", { "/home/ada/Genex": null }, "/home/ada/Genex"],
      ["the highest one first", { "/home": root(DIR | 0o1777), "/home/ada/Genex": own(DIR | 0o777) }, "/home"],
    ];
    for (const [name, overrides, shared] of cases)
      assert.equal(writableByOthers(EXECUTABLE, tree(overrides), PERSON), shared, name);
  });
});

/** Where the host keeps each of `commands`, symlinked into one folder: a PATH that holds nothing else. */
async function hostTools(root: string, commands: readonly string[]): Promise<string> {
  const tools = path.join(root, "tools");
  await mkdir(tools);
  for (const command of commands) {
    const found = ["/usr/bin", "/bin"].map((dir) => path.join(dir, command)).find((file) => existsSync(file));
    assert.ok(found, `${command} is on this host`);
    await symlink(found, path.join(tools, command));
  }
  return tools;
}

/** A folder standing in for /etc/apparmor.d and /sys, and a `bin` whose apparmor_parser records its calls. */
async function fakeSystem(options: { abi?: boolean; enabled?: string; parser?: boolean; parserExit?: number } = {}) {
  const root = await tmpDir("genex-apparmor-");
  const system: AppArmorSystem = {
    profileDir: path.join(root, "apparmor.d"),
    abiFile: path.join(root, "apparmor.d", "abi", "4.0"),
    enabledFile: path.join(root, "sys", "enabled"),
  };
  await mkdir(path.dirname(system.abiFile), { recursive: true });
  await mkdir(path.dirname(system.enabledFile), { recursive: true });
  if (options.abi ?? true) await writeFile(system.abiFile, "");
  await writeFile(system.enabledFile, `${options.enabled ?? "Y"}\n`);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const log = path.join(root, "parser.log");
  if (options.parser ?? true) {
    const parser = path.join(bin, "apparmor_parser");
    await writeFile(parser, `#!/bin/sh\necho "$*" >> '${log}'\nexit ${options.parserExit ?? 0}\n`);
    await chmod(parser, 0o755);
  }
  // `sudo` for the by-hand command: run the rest as this user.
  const sudo = path.join(bin, "sudo");
  await writeFile(sudo, '#!/bin/sh\nexec "$@"\n');
  await chmod(sudo, 0o755);
  // Only the fake bin and the few host tools the scripts use: a real apparmor_parser is never found.
  const tools = await hostTools(root, ["sh", "cat", "rm", "tr", "find", "dirname", "id"]);
  const env = { ...process.env, PATH: `${bin}:${tools}` };
  const parserCalls = async () =>
    existsSync(log) ? (await readFile(log, "utf8")).split("\n").filter(Boolean) : ([] as string[]);
  return { root, system, env, parserCalls };
}

/** Run a generated maintainer script with `args`, as dpkg or rpm would. */
async function runScript(script: string, args: string[], env: NodeJS.ProcessEnv, root: string) {
  const file = path.join(root, "script");
  await writeFile(file, script);
  await chmod(file, 0o755);
  return run("/bin/sh", [file, ...args], { env });
}

describe("Set up's install", { skip: POSIX_ONLY }, () => {
  it("pkexec runs a fixed script with the profile's file and text as arguments", () => {
    const profile = appArmorProfile("/home/ada/Genex portable/genex");
    assert.ok(profile);
    const argv = profileInstallArgv(profile);
    assert.deepEqual(argv.slice(0, 2), ["/bin/sh", "-c"]);
    assert.deepEqual(argv.slice(3), ["genex-apparmor", profile.file, profile.text]);
    assert.deepEqual(pkexecArgv(profile, "/usr/bin/pkexec"), ["/usr/bin/pkexec", ...argv]);
    const other = appArmorProfile("/opt/elsewhere/genex");
    assert.ok(other);
    assert.equal(profileInstallArgv(other)[2], argv[2], "the script is the same for every path");
  });

  it("writes the profile and loads it", async () => {
    const { system, env, parserCalls } = await fakeSystem();
    await mkdir(system.profileDir, { recursive: true });
    const profile = appArmorProfile("/home/ada/Genex portable/genex", system.profileDir);
    assert.ok(profile);
    const [file, ...args] = profileInstallArgv(profile);
    await run(file, args, { env });
    assert.equal(await readFile(profile.file, "utf8"), `${profile.text}\n`);
    assert.deepEqual(await parserCalls(), [`-r ${profile.file}`]);
  });

  it("takes a profile AppArmor refuses out again, and fails with its own exit code, never pkexec's 126", async () => {
    const { system, env, parserCalls } = await fakeSystem({ parserExit: 1 });
    await mkdir(system.profileDir, { recursive: true });
    const profile = appArmorProfile("/home/ada/Genex portable/genex", system.profileDir);
    assert.ok(profile);
    const [sh, ...args] = profileInstallArgv(profile);
    await assert.rejects(run(sh, args, { env }), { code: InstallExit.NotLoaded });
    assert.equal(existsSync(profile.file), false, "the refused profile is gone");
    assert.deepEqual(await parserCalls(), [`-r ${profile.file}`]);
  });

  it("fails with its own exit code when the file cannot be written, and loads nothing", async () => {
    const { system, env, parserCalls } = await fakeSystem();
    const profile = appArmorProfile("/home/ada/Genex portable/genex", path.join(system.profileDir, "missing"));
    assert.ok(profile);
    const [sh, ...args] = profileInstallArgv(profile);
    await assert.rejects(run(sh, args, { env }), { code: InstallExit.NotWritten });
    assert.deepEqual(await parserCalls(), []);
  });

  it("the by-hand command does the same, whatever quotes and spaces the path holds", async () => {
    const { system, env, parserCalls } = await fakeSystem();
    await mkdir(system.profileDir, { recursive: true });
    const profile = appArmorProfile("/home/ada/it's a 'test'/genex", system.profileDir);
    assert.ok(profile);
    const command = profileInstallCommand(profile);
    assert.ok(command.startsWith("sudo /bin/sh -c "), command);
    await run("/bin/sh", ["-c", command], { env });
    assert.equal(await readFile(profile.file, "utf8"), `${profile.text}\n`);
    assert.deepEqual(await parserCalls(), [`-r ${profile.file}`]);
  });

  it("the removal command unloads and deletes it, and deletes it even when it was not loaded", async () => {
    for (const parserExit of [0, 1]) {
      const { system, env, parserCalls } = await fakeSystem({ parserExit });
      await mkdir(system.profileDir, { recursive: true });
      const profile = appArmorProfile("/home/ada/Genex portable/genex", system.profileDir);
      assert.ok(profile);
      await writeFile(profile.file, profile.text);
      await run("/bin/sh", ["-c", profileRemoveCommand(profile)], { env });
      assert.equal(existsSync(profile.file), false, `parser exit ${parserExit}`);
      assert.deepEqual(await parserCalls(), [`-R ${profile.file}`]);
    }
  });
});

describe("the deb and rpm maintainer scripts", { skip: POSIX_ONLY }, () => {
  const packaged = (system: AppArmorSystem) => {
    const profile = appArmorProfile(LINUX_PACKAGED_EXECUTABLE, system.profileDir);
    assert.ok(profile);
    return profile;
  };

  it("install and load the packaged profile where AppArmor 4 is on (deb configure, rpm install and upgrade)", async () => {
    const installs: Array<[LinuxPackageScript, string[]]> = [
      [LinuxPackageScript.DebPostinst, ["configure", "0.1.0"]],
      [LinuxPackageScript.RpmPost, ["1"]],
      [LinuxPackageScript.RpmPost, ["2"]],
    ];
    for (const [script, args] of installs) {
      const { root, system, env, parserCalls } = await fakeSystem();
      const profile = packaged(system);
      await runScript(linuxPackageScripts(system)[script], args, env, root);
      assert.equal(await readFile(profile.file, "utf8"), `${profile.text}\n`, `${script} ${args}`);
      assert.deepEqual(await parserCalls(), [`-r ${profile.file}`], `${script} ${args}`);
    }
  });

  it("while AppArmor is disabled, keep a profile that parses and load nothing", async () => {
    const { root, system, env, parserCalls } = await fakeSystem({ enabled: "N" });
    await runScript(linuxPackageScripts(system)[LinuxPackageScript.DebPostinst], ["configure"], env, root);
    assert.ok(existsSync(packaged(system).file));
    assert.deepEqual(await parserCalls(), [`-QK ${packaged(system).file}`]);
  });

  it("while AppArmor is disabled, remove a profile that does not parse", async () => {
    const { root, system, env } = await fakeSystem({ enabled: "N", parserExit: 1 });
    const { stderr } = await runScript(
      linuxPackageScripts(system)[LinuxPackageScript.DebPostinst],
      ["configure"],
      env,
      root,
    );
    assert.equal(existsSync(packaged(system).file), false);
    assert.match(stderr, /genex: AppArmor refused/);
  });

  it("do nothing without apparmor_parser or AppArmor 4 (Ubuntu 22.04, Fedora), and never fail the install", async () => {
    for (const options of [{ parser: false }, { abi: false }]) {
      const { root, system, env, parserCalls } = await fakeSystem(options);
      for (const [script, args] of [
        [LinuxPackageScript.DebPostinst, ["configure"]],
        [LinuxPackageScript.RpmPost, ["1"]],
      ] as const) {
        await runScript(linuxPackageScripts(system)[script], [...args], env, root);
        assert.equal(existsSync(packaged(system).file), false, `${script} ${JSON.stringify(options)}`);
      }
      assert.deepEqual(await parserCalls(), []);
    }
  });

  it("keep the install going when the profile does not load, take the file out and say so", async () => {
    for (const [script, args] of [
      [LinuxPackageScript.DebPostinst, ["configure"]],
      [LinuxPackageScript.RpmPost, ["1"]],
    ] as const) {
      const { root, system, env } = await fakeSystem({ parserExit: 1 });
      const { stderr } = await runScript(linuxPackageScripts(system)[script], [...args], env, root);
      assert.match(stderr, /genex: AppArmor refused/, script);
      assert.equal(
        existsSync(packaged(system).file),
        false,
        `${script}: a refused profile must not wait for the next boot`,
      );
    }
  });

  it("leave a deb step other than configure alone", async () => {
    const { root, system, env, parserCalls } = await fakeSystem();
    for (const step of ["abort-upgrade", "abort-remove", "triggered"])
      await runScript(linuxPackageScripts(system)[LinuxPackageScript.DebPostinst], [step], env, root);
    assert.equal(existsSync(packaged(system).file), false);
    assert.deepEqual(await parserCalls(), []);
  });

  it("the rpm's scriptlets run the repository's after the profile's, as the make step writes them", async () => {
    // An rpm has one %post and one %postun: the profile's and the Genex repository's share them.
    const repoPost = await readFile(path.join(REPO, "build", "linux", "rpm-post"), "utf8");
    const repoPostun = await readFile(path.join(REPO, "build", "linux", "rpm-postun"), "utf8");
    const { root, system, env } = await fakeSystem();
    // The repository's scriptlets also copy the key and test a setting: the host's tools for that.
    await mkdir(path.join(root, "more"));
    const more = await hostTools(path.join(root, "more"), ["grep", "mkdir", "cp", "chmod"]);
    const packageEnv = { ...env, PATH: `${env.PATH}:${more}`, GENEX_PACKAGE_ROOT: root };
    const resources = path.join(root, "usr", "lib", "genex", "resources");
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(resources, "genex-archive-keyring.asc"), "key");
    await mkdir(path.join(root, "etc", "yum.repos.d"), { recursive: true });
    const scripts = linuxPackageScripts(system);
    const post = withFollowing(scripts[LinuxPackageScript.RpmPost], repoPost);
    await runScript(post, ["1"], packageEnv, root);
    assert.ok(existsSync(packaged(system).file), "the profile is installed");
    assert.ok(existsSync(path.join(root, "etc", "yum.repos.d", "genex.repo")), "the repository is added");
    const postun = withFollowing(scripts[LinuxPackageScript.RpmPostun], repoPostun);
    await runScript(postun, ["0"], packageEnv, root);
    assert.equal(existsSync(packaged(system).file), false, "the profile goes with the package");
    assert.equal(existsSync(path.join(root, "etc", "yum.repos.d", "genex.repo")), false, "so does the repository");
    // Written by the make step, each follows its own; a script with none following is the profile's alone.
    const dir = path.join(await tmpDir("genex-package-scripts-"), "scripts");
    await writeLinuxPackageScripts(dir, { [LinuxPackageScript.RpmPost]: repoPost });
    const files = linuxPackageScriptFiles(dir);
    assert.equal(
      await readFile(files[LinuxPackageScript.RpmPost], "utf8"),
      withFollowing(linuxPackageScripts().post, repoPost),
    );
    assert.equal(await readFile(files[LinuxPackageScript.RpmPostun], "utf8"), linuxPackageScripts().postun);
  });

  it("unload and delete the profile on removal, and keep it across an upgrade", async () => {
    const removals: Array<[LinuxPackageScript, string[], boolean]> = [
      [LinuxPackageScript.DebPostrm, ["remove"], true],
      [LinuxPackageScript.DebPostrm, ["purge"], true],
      [LinuxPackageScript.DebPostrm, ["upgrade", "0.2.0"], false],
      [LinuxPackageScript.RpmPostun, ["0"], true],
      [LinuxPackageScript.RpmPostun, ["1"], false],
    ];
    for (const [script, args, removes] of removals) {
      const { root, system, env, parserCalls } = await fakeSystem();
      const profile = packaged(system);
      await mkdir(system.profileDir, { recursive: true });
      await writeFile(profile.file, profile.text);
      await runScript(linuxPackageScripts(system)[script], args, env, root);
      assert.equal(existsSync(profile.file), !removes, `${script} ${args}`);
      assert.deepEqual(await parserCalls(), removes ? [`-R ${profile.file}`] : [], `${script} ${args}`);
    }
  });
});

describe("packaging wiring", () => {
  const config = require("../../forge.config.cjs");
  const maker = (name: string) => config.makers.find((entry: { name: string }) => entry.name === name);

  it("the deb and rpm install Genex at the path the packaged profile names", () => {
    for (const name of ["@electron-forge/maker-deb", "@electron-forge/maker-rpm"]) {
      const { options } = maker(name).config;
      assert.equal(path.posix.join("/usr/lib", options.name, options.bin), LINUX_PACKAGED_EXECUTABLE, name);
    }
  });

  it("the deb ships its checked-in maintainer scripts, and the rpm reads each one where the make step writes it", () => {
    const files = linuxPackageScriptFiles(path.join(REPO, "out", "linux-package-scripts"));
    // FLIPPED: the deb keeps build/linux/postinst and postrm (linux-deb-scripts.test.ts holds their
    // text), which install the same `genex` profile; only the rpm's scriptlets are generated.
    assert.deepEqual(maker("@electron-forge/maker-deb").config.options.scripts, {
      postinst: path.join(REPO, "build", "linux", "postinst"),
      postrm: path.join(REPO, "build", "linux", "postrm"),
    });
    assert.deepEqual(maker("@electron-forge/maker-rpm").config.options.scripts, {
      [LinuxPackageScript.RpmPost]: files[LinuxPackageScript.RpmPost],
      [LinuxPackageScript.RpmPostun]: files[LinuxPackageScript.RpmPostun],
    });
  });

  it("the make step writes every maintainer script, executable", { skip: POSIX_ONLY }, async () => {
    const dir = path.join(await tmpDir("genex-package-scripts-"), "scripts");
    await writeLinuxPackageScripts(dir);
    const expected = linuxPackageScripts();
    for (const [key, file] of Object.entries(linuxPackageScriptFiles(dir)) as Array<[LinuxPackageScript, string]>) {
      assert.equal(await readFile(file, "utf8"), expected[key], key);
      await access(file, constants.X_OK);
    }
  });
});

/** The first folder Set up refuses on the way to `executable` on this machine, or null. */
const setUpRefuses = (executable: string) => writableByOthers(executable, inspectPath, currentPerson());

/** Folders `ownedRoot` made outside the temporary folder `tmpDir` cleans. */
const ownedRoots: string[] = [];
after(() => Promise.all(ownedRoots.map((dir) => rm(dir, { recursive: true, force: true }))));

/**
 * A fresh folder (its physical path) under the first temporary folder Set up would accept a copy
 * in: a GitHub runner's /tmp is shared, its RUNNER_TEMP is not. Where there is none, a plain
 * temporary folder, and the rows below then check that the command refuses as Set up does.
 */
async function ownedRoot(): Promise<string> {
  for (const base of [os.tmpdir(), process.env.RUNNER_TEMP]) {
    if (!base || setUpRefuses(await realpath(base))) continue;
    const made = await realpath(await mkdtemp(path.join(base, "genex-readme-")));
    ownedRoots.push(made);
    return made;
  }
  return realpath(await tmpDir("genex-readme-"));
}

/** A copy unzipped into `name` under `root`: the folder, with an executable `genex`. */
async function unzipped(root: string, name: string, executable = true): Promise<string> {
  const folder = path.join(root, name);
  await mkdir(folder, { recursive: true });
  if (executable) await writeFile(path.join(folder, "genex"), "#!/bin/sh\n", { mode: 0o755 });
  return folder;
}

/**
 * Run the README's command where the person would: in the unzipped folder, reached by `entered`
 * (a link to it, say), which is what the shell's own `pwd` then reports.
 */
async function runReadmeCommand(entered: string, profileDir: string, env: NodeJS.ProcessEnv) {
  return run("/bin/sh", ["-c", portableInstallScript(profileDir)], { cwd: entered, env: { ...env, PWD: entered } });
}

/**
 * Run the command for the copy in `folder` (entered through `entered`) and check it did exactly what
 * Set up does for `<realpath>/genex`: refuse the same shared folder, or write and load the same profile.
 */
async function sameAsSetUp(label: string, folder: string, entered = folder): Promise<void> {
  const readme = await fakeSystem();
  await mkdir(readme.system.profileDir, { recursive: true });
  const executable = path.join(await realpath(folder), "genex");
  const { stderr } = await runReadmeCommand(entered, readme.system.profileDir, readme.env);
  const shared = setUpRefuses(executable);
  if (shared) {
    assert.deepEqual(await readdir(readme.system.profileDir), ["abi"], label);
    assert.deepEqual(await readme.parserCalls(), [], label);
    assert.ok(stderr.includes(`Someone other than root and you can change ${shared},`), `${label}: ${stderr}`);
    return;
  }
  const setUp = await fakeSystem();
  await mkdir(setUp.system.profileDir, { recursive: true });
  const profile = appArmorProfile(executable, setUp.system.profileDir);
  assert.ok(profile, label);
  const [sh, ...args] = profileInstallArgv(profile);
  await run(sh, args, { env: setUp.env });
  const written = path.join(readme.system.profileDir, AppArmorProfileName.Portable);
  assert.equal(await readFile(written, "utf8"), await readFile(profile.file, "utf8"), label);
  assert.equal(await readFile(written, "utf8"), `${profile.text}\n`, label);
  assert.deepEqual(await readme.parserCalls(), [`-r ${written}`], label);
}

describe("the Linux zip's README-LINUX.txt", { skip: POSIX_ONLY }, () => {
  it("carries the same install Set up runs for <unzipped>/genex, whatever the folder is called", async () => {
    const names = [
      "Genex-linux-x64",
      "Genex portable",
      "it's mine",
      "Genex (1)",
      "иван/Genex",
      "a,b#c",
      "plain.+_-dir",
    ];
    const root = await ownedRoot();
    for (const name of names) await sameAsSetUp(name, await unzipped(root, name));
  });

  it("names the physical folder when the person enters it through a link, as Set up does", async () => {
    const root = await ownedRoot();
    const folder = await unzipped(root, "Genex-linux-x64");
    const link = path.join(root, "Genex");
    await symlink(folder, link, "dir");
    // The shell's own `pwd` reports the link here; the profile must name the physical path.
    await sameAsSetUp("entered through a link", folder, link);
  });

  it("refuses a folder someone other than root and you could change, as Set up does, and writes nothing", async () => {
    // Each opens paths on the copy's way up to everyone, highest first: [label, [path, new mode]...].
    // Set up names the highest; so must the command.
    const cases: Array<[string, Array<[(folder: string) => string, number]>]> = [
      ["a world-writable folder", [[(folder) => folder, 0o777]]],
      ["a folder under a sticky world-writable one, as in /tmp", [[(folder) => path.dirname(folder), 0o1777]]],
      ["a world-writable genex", [[(folder) => path.join(folder, "genex"), 0o777]]],
      [
        "a world-writable folder under a sticky world-writable one",
        [
          [(folder) => path.dirname(folder), 0o1777],
          [(folder) => folder, 0o777],
        ],
      ],
    ];
    for (const [label, openings] of cases) {
      const root = await ownedRoot();
      const folder = await unzipped(path.join(root, "shared"), "Genex-linux-x64");
      const clean = setUpRefuses(path.join(folder, "genex")) === null;
      for (const [pathOf, mode] of openings) await chmod(pathOf(folder), mode);
      const [[highest]] = openings;
      const refused = setUpRefuses(path.join(folder, "genex"));
      assert.ok(refused, `${label}: Set up refuses it`);
      if (clean) assert.equal(refused, highest(folder), `${label}: the highest folder opened up is the one named`);
      await sameAsSetUp(label, folder);
    }
  });

  it("writes nothing for a folder a profile cannot name, or when run outside the unzipped folder", async () => {
    const cases: Array<[string, string, boolean]> = [
      ["a pattern character", "gen*ex", true],
      ["a question mark", "what?", true],
      ["brackets", "[x]", true],
      ["braces", "{a,b}", true],
      ["a caret", "a^b", true],
      ["a variable", "@{HOME}", true],
      ["a double quote", 'a"b', true],
      ["a backslash", "a\\b", true],
      ["a newline", "a\nb", true],
      ["a tab", "a\tb", true],
      ["a folder without genex", "Downloads", false],
    ];
    for (const [label, name, executable] of cases) {
      const { root, system, env, parserCalls } = await fakeSystem();
      await mkdir(system.profileDir, { recursive: true });
      const folder = await unzipped(root, name, executable);
      const { stderr } = await runReadmeCommand(folder, system.profileDir, env);
      assert.deepEqual(await readdir(system.profileDir), ["abi"], label);
      assert.deepEqual(await parserCalls(), [], label);
      assert.notEqual(stderr, "", `${label}: the person is told why`);
    }
  });

  it("names Chromium's words, the command and the removal", () => {
    const readme = portableReadme();
    assert.ok(readme.includes(portableInstallScript()));
    for (const fatal of CHROMIUM_SANDBOX_FATALS) assert.ok(readme.includes(fatal), fatal);
    const profile = appArmorProfile("/home/ada/Genex-linux-x64/genex");
    assert.ok(profile);
    assert.ok(readme.includes(profileRemoveCommand(profile)));
    assert.equal(portableReadme(), readme, "the same text every time");
  });
});

describe("the Linux zip carries README-LINUX.txt", { skip: POSIX_ONLY }, () => {
  const config = require("../../forge.config.cjs");
  const { version } = require("../../package.json");

  /** A zip of `top/` holding `files`, made as maker-zip makes it (`zip -r -y` from the parent). */
  async function zipOf(dir: string, zipName: string, top: string, files: Record<string, string>): Promise<string> {
    const source = await tmpDir("genex-zip-source-");
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(source, top, name)), { recursive: true });
      await writeFile(path.join(source, top, name), text);
    }
    const zip = path.join(dir, zipName);
    await mkdir(dir, { recursive: true });
    await run("zip", ["-q", "-r", "-y", zip, top], { cwd: source });
    return zip;
  }

  it("the make step adds it beside genex in the Linux zip, and leaves every other artifact as it was", async () => {
    const make = await tmpDir("genex-make-");
    const linuxZip = await zipOf(
      path.join(make, "zip", "linux", "x64"),
      `Genex-linux-x64-${version}.zip`,
      "Genex-linux-x64",
      { genex: "#!/bin/sh\n" },
    );
    const darwinZip = await zipOf(
      path.join(make, "zip", "darwin", "arm64"),
      `Genex-darwin-arm64-${version}.zip`,
      "Genex.app",
      { "Contents/Info.plist": "<plist/>" },
    );
    const deb = path.join(make, "genex_amd64.deb");
    await writeFile(deb, "not really a deb");
    const before = {
      darwin: await readFile(darwinZip),
      deb: await readFile(deb),
    };
    const results = [
      { platform: "linux", arch: "x64", packageJSON: { version }, artifacts: [linuxZip, deb] },
      { platform: "darwin", arch: "arm64", packageJSON: { version }, artifacts: [darwinZip] },
    ];
    assert.deepEqual(await config.hooks.postMake(config, results), results, "the make results pass through");
    const { stdout: entries } = await run("unzip", ["-Z1", linuxZip]);
    assert.deepEqual(entries.trim().split("\n").sort(), [
      "Genex-linux-x64/",
      "Genex-linux-x64/README-LINUX.txt",
      "Genex-linux-x64/genex",
    ]);
    const { stdout: readme } = await run("unzip", ["-p", linuxZip, "Genex-linux-x64/README-LINUX.txt"]);
    assert.equal(readme, portableReadme());
    assert.deepEqual(await readFile(darwinZip), before.darwin, "the darwin zip is untouched");
    assert.deepEqual(await readFile(deb), before.deb, "the deb is untouched");
  });

  it("refuses a Linux zip whose name does not follow maker-zip's, and changes nothing", async () => {
    const make = await tmpDir("genex-make-");
    const odd = await zipOf(path.join(make, "zip", "linux", "x64"), "genex.zip", "Genex-linux-x64", {
      genex: "#!/bin/sh\n",
    });
    const before = await readFile(odd);
    const results = [{ platform: "linux", arch: "x64", packageJSON: { version }, artifacts: [odd] }];
    await assert.rejects(config.hooks.postMake(config, results), /genex\.zip/);
    assert.deepEqual(await readFile(odd), before);
  });
});

describe("ci-linux-userns: an unprofiled copy under the restriction", () => {
  const NO_SANDBOX =
    "[4242:0101/000000.000000:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.\n";
  const SUID_NOT_ROOT =
    "[4242:0101/000000.000000:FATAL:zygote_host_impl_linux.cc(218)] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that /home/runner/Genex zip/Genex-linux-x64/chrome-sandbox is owned by root and has mode 4755.\n";

  /** A launched copy that writes `stderr` in pieces and ends as `ends` says, or never. */
  function fakeLaunch(stderr: string[], ends: AppExit | "never" | "no-start") {
    const calls = { launched: [] as string[], killed: 0, waited: [] as number[], deadlines: [] as AbortSignal[] };
    const launch: LaunchApp = (executable) => {
      calls.launched.push(executable);
      return {
        onStderr: (listener) => {
          for (const chunk of stderr) listener(chunk);
        },
        exited:
          ends === "never"
            ? new Promise<AppExit>(() => {})
            : Promise.resolve(ends === "no-start" ? { code: null, signal: null, error: "spawn ENOENT" } : ends),
        kill: () => {
          calls.killed += 1;
        },
      };
    };
    // The deadline passes at once when the copy never ends; otherwise it would never pass by itself.
    const wait = async (ms: number, signal: AbortSignal) => {
      calls.waited.push(ms);
      calls.deadlines.push(signal);
      if (ends !== "never") await new Promise<void>(() => {});
    };
    return { launch, wait, calls };
  }

  it("passes on either of Chromium's sandbox FATALs with a non-zero end, and fails on anything else", async () => {
    const cases: Array<[string, string[], AppExit | "never" | "no-start", UnprofiledFailure | null]> = [
      ["exit 1 with 'No usable sandbox'", [NO_SANDBOX], { code: 1, signal: null }, null],
      ["killed by its own FATAL (SIGTRAP)", [NO_SANDBOX], { code: null, signal: "SIGTRAP" }, null],
      [
        "the setuid helper beside it is not root's (an unzipped copy)",
        [SUID_NOT_ROOT],
        { code: 1, signal: null },
        null,
      ],
      ["the setuid helper's FATAL, killed by SIGTRAP", [SUID_NOT_ROOT], { code: null, signal: "SIGTRAP" }, null],
      ["the message split across chunks", ["No usa", "ble sandbox! see"], { code: 133, signal: null }, null],
      [
        "the setuid message split across chunks",
        ["The SUID sandbox helper binary was fo", "und, but is not configured correctly. R"],
        { code: 133, signal: null },
        null,
      ],
      ["exit 0", [], { code: 0, signal: null }, UnprofiledFailure.ExitedZero],
      ["exit 0 even with the message", [NO_SANDBOX], { code: 0, signal: null }, UnprofiledFailure.ExitedZero],
      ["exit 0 even with the setuid message", [SUID_NOT_ROOT], { code: 0, signal: null }, UnprofiledFailure.ExitedZero],
      ["still running at the deadline", [], "never", UnprofiledFailure.StillRunning],
      ["another error", ["Missing X server or $DISPLAY\n"], { code: 1, signal: null }, UnprofiledFailure.OtherError],
      ["never started", [], "no-start", UnprofiledFailure.DidNotStart],
    ];
    for (const [name, stderr, ends, expected] of cases) {
      const { launch, wait, calls } = fakeLaunch(stderr, ends);
      assert.equal(await checkUnprofiledCopy("/home/runner/Genex zip/genex", { launch, wait }), expected, name);
      assert.deepEqual(calls.launched, ["/home/runner/Genex zip/genex"], name);
      assert.deepEqual(calls.waited, [UNPROFILED_EXIT_TIMEOUT_MS], name);
      assert.equal(calls.killed, ends === "never" ? 1 : 0, `${name}: only a copy still running is killed`);
      assert.equal(calls.deadlines.length, 1, name);
      assert.equal(calls.deadlines[0]?.aborted, ends !== "never", `${name}: a copy that ended cancels the deadline`);
    }
    assert.equal(UNPROFILED_EXIT_TIMEOUT_MS, 30_000);
  });
});
