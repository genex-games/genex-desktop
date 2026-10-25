/**
 * The rpm's %post and %postun. %post adds the Genex package repository (packages.genex.games) and
 * its key, so dnf and GNOME Software bring every later version; %postun takes both away on
 * uninstall and keeps them through an upgrade. Neither may ever fail. They run here against
 * `GENEX_PACKAGE_ROOT`, the stand-in for the root rpm installs into.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { tmpDir } from "../helpers/tmp.ts";

const require = createRequire(import.meta.url);
const config = require("../../forge.config.cjs");
const rpm = config.makers.find((maker: { name: string }) => maker.name === "@electron-forge/maker-rpm");
const scripts: { post: string; postun: string } = rpm.config.options.scripts;
const REPO_FILE = path.join("etc", "yum.repos.d", "genex.repo");
const RPM_KEY = path.join("etc", "pki", "rpm-gpg", "RPM-GPG-KEY-genex");
const SHIPPED_KEY = path.join("usr", "lib", "genex", "resources", "genex-archive-keyring.asc");
const KEY = path.join(import.meta.dirname, "..", "..", "build", "linux", "genex-archive-keyring.asc");

async function unpacked(options: { yum?: boolean; defaults?: string } = {}): Promise<string> {
  const root = await tmpDir("rpm-root-");
  await mkdir(path.join(root, path.dirname(SHIPPED_KEY)), { recursive: true });
  await writeFile(path.join(root, SHIPPED_KEY), await readFile(KEY));
  if (options.yum ?? true) await mkdir(path.join(root, "etc", "yum.repos.d"), { recursive: true });
  if (options.defaults !== undefined) {
    await mkdir(path.join(root, "etc", "default"), { recursive: true });
    await writeFile(path.join(root, "etc", "default", "genex"), options.defaults);
  }
  return root;
}

function run(script: string, arg: string, root: string) {
  return spawnSync("/bin/sh", [script, arg], {
    env: { PATH: "/usr/bin:/bin", GENEX_PACKAGE_ROOT: root },
    encoding: "utf8",
  });
}

const read = (root: string, file: string) => readFile(path.join(root, file), "utf8").catch(() => null);

describe("the rpm's package repository", { skip: process.platform === "win32" && "runs the scriptlets in sh" }, () => {
  it("adds the signed repository and its key on install", async () => {
    const root = await unpacked();
    assert.equal(run(scripts.post, "1", root).status, 0);
    const repo = await read(root, REPO_FILE);
    assert.match(repo ?? "", /^baseurl=https:\/\/packages\.genex\.games\/rpm$/m);
    assert.match(repo ?? "", /^gpgcheck=1$/m);
    assert.match(repo ?? "", /^repo_gpgcheck=1$/m);
    assert.match(repo ?? "", /^gpgkey=file:\/\/\/etc\/pki\/rpm-gpg\/RPM-GPG-KEY-genex$/m);
    assert.equal(await read(root, RPM_KEY), await readFile(KEY, "utf8"));
  });

  it("keeps a repository file the person edited, and refreshes the key", async () => {
    const root = await unpacked();
    await mkdir(path.join(root, path.dirname(RPM_KEY)), { recursive: true });
    await writeFile(path.join(root, REPO_FILE), "[genex]\nenabled=0\n");
    await writeFile(path.join(root, RPM_KEY), "an old key\n");
    run(scripts.post, "2", root);
    assert.equal(await read(root, REPO_FILE), "[genex]\nenabled=0\n");
    assert.equal(await read(root, RPM_KEY), await readFile(KEY, "utf8"));
  });

  it("adds nothing when the person turned it off or the system has no yum repositories", async () => {
    for (const root of [await unpacked({ defaults: "repo=off\n" }), await unpacked({ yum: false })]) {
      assert.equal(run(scripts.post, "1", root).status, 0);
      assert.equal(await read(root, REPO_FILE), null, root);
    }
  });

  it("takes them away on uninstall and keeps them through an upgrade", async () => {
    for (const [arg, kept] of [
      ["0", false],
      ["1", true],
    ] as const) {
      const root = await unpacked();
      run(scripts.post, "1", root);
      assert.equal(run(scripts.postun, arg, root).status, 0);
      assert.equal((await read(root, REPO_FILE)) !== null, kept, arg);
      assert.equal((await read(root, RPM_KEY)) !== null, kept, arg);
    }
  });
});
