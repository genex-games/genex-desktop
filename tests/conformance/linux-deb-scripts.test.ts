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
