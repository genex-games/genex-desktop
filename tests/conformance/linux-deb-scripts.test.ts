/**
 * The .deb's maintainer scripts. On Ubuntu 24.04 and the distributions built on it (Zorin OS 18,
 * Mint 22, Pop!_OS 24.04) bubblewrap gets user namespaces with capabilities only under an AppArmor
 * profile that allows them, so the installed app's sandbox could not start a single agent process.
 * postinst installs the profile `appArmorProfile` writes for /usr/lib/genex/genex and loads it,
 * where the system's AppArmor understands it; postrm takes it away on remove and purge. Neither may
 * ever fail the install. The scripts run here against `$DPKG_ROOT` with stand-ins on PATH.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { appArmorProfile } from "../../src/substrate/linux-isolation.ts";
import { tmpDir } from "../helpers/tmp.ts";

const require = createRequire(import.meta.url);
const config = require("../../forge.config.cjs");
const deb = config.makers.find((maker: { name: string }) => maker.name === "@electron-forge/maker-deb");
const scripts: { postinst: string; postrm: string } = deb.config.options.scripts;
/** Where electron-installer-debian puts the packaged executable: /usr/lib/<name>/<bin>. */
const INSTALLED_EXEC = `/usr/lib/${deb.config.options.name}/${deb.config.options.bin}`;
const PROFILE = path.join("etc", "apparmor.d", "genex");

/** How the stand-ins on PATH behave: each exit status, and which ones exist at all. */
interface Machine {
  /** apparmor_parser is installed. */
  parser?: boolean;
  /** Exit status of the parser's compile-only check (non-zero: an AppArmor older than 4.0). */
  parseStatus?: number;
  /** Exit status of loading or removing the profile in the kernel. */
  loadStatus?: number;
  /** aa-enabled's exit status (0: AppArmor is on in the kernel). */
  enabledStatus?: number;
  /** ischroot's exit status (0: inside a chroot, where nothing is loaded live). */
  chrootStatus?: number;
}

async function run(script: string, args: string[], machine: Machine = {}, root?: string) {
  const dpkgRoot = root ?? (await tmpDir("deb-root-"));
  await mkdir(path.join(dpkgRoot, "etc", "apparmor.d"), { recursive: true });
  const bin = await tmpDir("deb-bin-");
  const log = path.join(bin, "calls.log");
  const stub = async (name: string, body: string) => {
    await writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  };
  if (machine.parser ?? true)
    await stub(
      "apparmor_parser",
      `case " $* " in *" --skip-kernel-load "*) exit ${machine.parseStatus ?? 0};; esac\nexit ${machine.loadStatus ?? 0}`,
    );
  await stub("aa-enabled", `exit ${machine.enabledStatus ?? 0}`);
  await stub("ischroot", `exit ${machine.chrootStatus ?? 1}`);
  const result = spawnSync("/bin/sh", [script, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, DPKG_ROOT: dpkgRoot, CALLS: log },
    encoding: "utf8",
  });
  const calls = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const profile = path.join(dpkgRoot, PROFILE);
  return {
    root: dpkgRoot,
    status: result.status,
    stderr: result.stderr,
    calls,
    profile: existsSync(profile) ? await readFile(profile, "utf8") : null,
  };
}

describe("the deb's postinst", { skip: process.platform === "win32" && "runs the maintainer scripts in sh" }, () => {
  it("installs the profile for the packaged executable and loads it", async () => {
    const ran = await run(scripts.postinst, ["configure", ""]);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.profile, appArmorProfile(INSTALLED_EXEC));
    assert.ok(
      ran.calls.some((call) => call.startsWith("apparmor_parser --replace") && call.endsWith(`/${PROFILE}`)),
      ran.calls.join("\n"),
    );
  });

  it("installs nothing where AppArmor cannot read the profile or is not installed", async () => {
    for (const machine of [{ parseStatus: 1 }, { parser: false }]) {
      const ran = await run(scripts.postinst, ["configure", ""], machine);
      assert.equal(ran.status, 0, JSON.stringify(machine));
      assert.equal(ran.profile, null, JSON.stringify(machine));
      assert.ok(!ran.calls.some((call) => call.startsWith("apparmor_parser --replace")), JSON.stringify(machine));
    }
  });

  it("installs the profile but loads nothing in a chroot or with AppArmor off", async () => {
    for (const machine of [{ chrootStatus: 0 }, { enabledStatus: 1 }]) {
      const ran = await run(scripts.postinst, ["configure", ""], machine);
      assert.equal(ran.status, 0, JSON.stringify(machine));
      assert.equal(ran.profile, appArmorProfile(INSTALLED_EXEC), JSON.stringify(machine));
      assert.ok(!ran.calls.some((call) => call.startsWith("apparmor_parser --replace")), JSON.stringify(machine));
    }
  });

  it("never fails the install, even when the kernel refuses the profile", async () => {
    const ran = await run(scripts.postinst, ["configure", ""], { loadStatus: 1 });
    assert.equal(ran.status, 0, ran.stderr);
  });

  it("does nothing on an aborted upgrade", async () => {
    const ran = await run(scripts.postinst, ["abort-upgrade", "1.0.0"]);
    assert.equal(ran.status, 0);
    assert.equal(ran.profile, null);
    assert.deepEqual(ran.calls, []);
  });
});

describe("the deb's postrm", { skip: process.platform === "win32" && "runs the maintainer scripts in sh" }, () => {
  async function installed(): Promise<string> {
    const root = await tmpDir("deb-root-");
    const ran = await run(scripts.postinst, ["configure", ""], {}, root);
    assert.ok(ran.profile);
    return root;
  }

  it("unloads and removes the profile on remove and purge", async () => {
    for (const action of ["remove", "purge"]) {
      const ran = await run(scripts.postrm, [action], {}, await installed());
      assert.equal(ran.status, 0, action);
      assert.equal(ran.profile, null, action);
      assert.ok(
        ran.calls.some((call) => call.startsWith("apparmor_parser --remove")),
        `${action}: ${ran.calls.join("\n")}`,
      );
    }
  });

  it("keeps it through an upgrade, whose new postinst writes it again", async () => {
    const ran = await run(scripts.postrm, ["upgrade", "1.0.0"], {}, await installed());
    assert.equal(ran.status, 0);
    assert.equal(ran.profile, appArmorProfile(INSTALLED_EXEC));
    assert.deepEqual(ran.calls, []);
  });

  it("never fails the removal, even when the kernel refuses to unload", async () => {
    const ran = await run(scripts.postrm, ["remove"], { loadStatus: 1 }, await installed());
    assert.equal(ran.status, 0);
    assert.equal(ran.profile, null);
  });
});

/** The Genex package repository the deb adds, so apt brings every later version. */
const APT_LIST = path.join("etc", "apt", "sources.list.d", "genex.list");
const APT_KEY = path.join("etc", "apt", "keyrings", "genex.asc");
/** Where the packaged app carries the repository's public key (forge `extraResource`). */
const SHIPPED_KEY = path.join("usr", "lib", "genex", "resources", "genex-archive-keyring.asc");
const KEY = path.join(import.meta.dirname, "..", "..", "build", "linux", "genex-archive-keyring.asc");

/** A root with the package's files unpacked and apt present, as dpkg leaves it before postinst. */
async function unpacked(options: { apt?: boolean; defaults?: string } = {}): Promise<string> {
  const root = await tmpDir("deb-root-");
  await mkdir(path.join(root, path.dirname(SHIPPED_KEY)), { recursive: true });
  await writeFile(path.join(root, SHIPPED_KEY), await readFile(KEY));
  if (options.apt ?? true) await mkdir(path.join(root, "etc", "apt", "sources.list.d"), { recursive: true });
  if (options.defaults !== undefined) {
    await mkdir(path.join(root, "etc", "default"), { recursive: true });
    await writeFile(path.join(root, "etc", "default", "genex"), options.defaults);
  }
  return root;
}

const read = (root: string, file: string) => readFile(path.join(root, file), "utf8").catch(() => null);

describe("the deb's package repository", {
  skip: process.platform === "win32" && "runs the maintainer scripts in sh",
}, () => {
  it("adds the signed repository and its key on install", async () => {
    const root = await unpacked();
    const ran = await run(scripts.postinst, ["configure", ""], {}, root);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(
      await read(root, APT_LIST),
      "deb [arch=amd64 signed-by=/etc/apt/keyrings/genex.asc] https://packages.genex.games stable main\n",
    );
    assert.equal(await read(root, APT_KEY), await readFile(KEY, "utf8"));
  });

  it("keeps a repository line the person edited, and refreshes the key", async () => {
    const root = await unpacked();
    await mkdir(path.join(root, "etc", "apt", "keyrings"), { recursive: true });
    await writeFile(path.join(root, APT_LIST), "# deb https://packages.genex.games stable main\n");
    await writeFile(path.join(root, APT_KEY), "an old key\n");
    await run(scripts.postinst, ["configure", "0.1.7"], {}, root);
    assert.equal(await read(root, APT_LIST), "# deb https://packages.genex.games stable main\n");
    assert.equal(await read(root, APT_KEY), await readFile(KEY, "utf8"));
  });

  it("adds nothing when the person turned it off, without apt, or without the shipped key", async () => {
    const off = await unpacked({ defaults: "repo=off\n" });
    const noApt = await unpacked({ apt: false });
    const noKey = await unpacked();
    await writeFile(path.join(noKey, SHIPPED_KEY), "");
    for (const root of [off, noApt, noKey]) {
      const ran = await run(scripts.postinst, ["configure", ""], {}, root);
      assert.equal(ran.status, 0, root);
      assert.equal(await read(root, APT_LIST), null, root);
    }
  });

  it("takes the repository and its key away on remove and purge, and keeps them through an upgrade", async () => {
    for (const [action, kept] of [
      ["remove", false],
      ["purge", false],
      ["upgrade", true],
    ] as const) {
      const root = await unpacked();
      await run(scripts.postinst, ["configure", ""], {}, root);
      const ran = await run(scripts.postrm, [action], {}, root);
      assert.equal(ran.status, 0, action);
      assert.equal((await read(root, APT_LIST)) !== null, kept, action);
      assert.equal((await read(root, APT_KEY)) !== null, kept, action);
    }
  });
});

/**
 * Ubuntu 24.10 and later confine /usr/bin/bwrap itself (AppArmor's `bwrap-userns-restrict`): its
 * children run under `unpriv_bwrap`, which denies every capability, so the nested user namespace
 * the sandbox's seccomp step makes is refused and no agent process starts. A copy beside the app
 * attaches to no profile of its own and runs under the app's, as bubblewrap does on 24.04.
 */
const SYSTEM_BWRAP = path.join("usr", "bin", "bwrap");
const OWN_BWRAP = path.join("usr", "lib", "genex", "bwrap");
const BWRAP_RESTRICTION = path.join("etc", "apparmor.d", "bwrap-userns-restrict");

/** A root with bubblewrap installed and, when `restricted`, Ubuntu's profile confining it. */
async function withBubblewrap(options: { restricted: boolean; setuid?: boolean }): Promise<string> {
  const root = await unpacked();
  await mkdir(path.join(root, path.dirname(SYSTEM_BWRAP)), { recursive: true });
  await writeFile(path.join(root, SYSTEM_BWRAP), "#!/bin/sh\necho system bubblewrap\n");
  await chmod(path.join(root, SYSTEM_BWRAP), options.setuid ? 0o4755 : 0o755);
  if (options.restricted) {
    await mkdir(path.join(root, path.dirname(BWRAP_RESTRICTION)), { recursive: true });
    await writeFile(path.join(root, BWRAP_RESTRICTION), "profile bwrap /usr/bin/bwrap {}\n");
  }
  return root;
}

describe("the app's own bubblewrap", {
  skip: process.platform === "win32" && "runs the maintainer scripts in sh",
}, () => {
  it("is copied beside the app where the system confines /usr/bin/bwrap", async () => {
    const root = await withBubblewrap({ restricted: true });
    const ran = await run(scripts.postinst, ["configure", ""], {}, root);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(await read(root, OWN_BWRAP), await read(root, SYSTEM_BWRAP));
    const { stat } = await import("node:fs/promises");
    assert.equal((await stat(path.join(root, OWN_BWRAP))).mode & 0o7777, 0o755);
  });

  it("is refreshed by an upgrade, so a newer system bubblewrap reaches it", async () => {
    const root = await withBubblewrap({ restricted: true });
    await run(scripts.postinst, ["configure", ""], {}, root);
    await writeFile(path.join(root, SYSTEM_BWRAP), "#!/bin/sh\necho newer bubblewrap\n");
    await run(scripts.postinst, ["configure", "0.1.10"], {}, root);
    assert.equal(await read(root, OWN_BWRAP), "#!/bin/sh\necho newer bubblewrap\n");
  });

  it("is not made, and an old one goes, where /usr/bin/bwrap is unconfined, missing or setuid", async () => {
    for (const options of [{ restricted: false }, { restricted: true, setuid: true }]) {
      const root = await withBubblewrap(options);
      await mkdir(path.join(root, path.dirname(OWN_BWRAP)), { recursive: true });
      await writeFile(path.join(root, OWN_BWRAP), "stale copy\n");
      const ran = await run(scripts.postinst, ["configure", ""], {}, root);
      assert.equal(ran.status, 0, JSON.stringify(options));
      assert.equal(await read(root, OWN_BWRAP), null, JSON.stringify(options));
    }
    const missing = await unpacked();
    await mkdir(path.join(missing, path.dirname(BWRAP_RESTRICTION)), { recursive: true });
    await writeFile(path.join(missing, BWRAP_RESTRICTION), "profile bwrap /usr/bin/bwrap {}\n");
    const ran = await run(scripts.postinst, ["configure", ""], {}, missing);
    assert.equal(ran.status, 0);
    assert.equal(await read(missing, OWN_BWRAP), null);
  });

  it("goes with the app on remove and purge, and stays through an upgrade", async () => {
    for (const [action, kept] of [
      ["remove", false],
      ["purge", false],
      ["upgrade", true],
    ] as const) {
      const root = await withBubblewrap({ restricted: true });
      await run(scripts.postinst, ["configure", ""], {}, root);
      const ran = await run(scripts.postrm, [action], {}, root);
      assert.equal(ran.status, 0, action);
      assert.equal((await read(root, OWN_BWRAP)) !== null, kept, action);
    }
  });
});
