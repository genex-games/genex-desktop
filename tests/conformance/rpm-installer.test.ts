import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, cp, symlink, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { patchRpmInstaller } from "../../scripts/patch-rpm-installer.mjs";
import { tmpDir } from "../helpers/tmp.ts";

const require = createRequire(import.meta.url);
const installedPackage = (() => {
  try {
    return path.join(path.dirname(path.dirname(require.resolve("electron-installer-redhat"))), "package.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
})();
const optionalInstaller = { skip: installedPackage ? false : "RPM installer is optional and absent on this platform" };

async function copiedInstaller(version?: string, changedTarget = false) {
  assert.ok(installedPackage);
  const root = await tmpDir("studio-rpm-patch-");
  const moduleRoot = path.join(root, "copied-installer");
  await cp(path.dirname(installedPackage), moduleRoot, { recursive: true });
  // Runtime dependencies are read from the checkout, while the installer itself is an owned copy.
  await symlink(path.dirname(path.dirname(installedPackage)), path.join(root, "node_modules"), "dir");
  const pkg = path.join(moduleRoot, "package.json");
  const file = path.join(moduleRoot, "src", "installer.js");
  if (version) {
    const metadata = JSON.parse(await readFile(pkg, "utf8"));
    await writeFile(pkg, JSON.stringify({ ...metadata, version }));
  }
  await writeFile(
    path.join(moduleRoot, "src", "spawn.js"),
    `
export const calls = [];
export default async function spawn(command, args, logger) {
  calls.push({command, args, logger});
  return "fixture RPM result";
}
`,
  );
  if (changedTarget)
    await writeFile(
      file,
      `
import spawn from './spawn.js';
export class Installer {
  async createPackage() {
    await spawn('rpmbuild', ['-bb', this.specPath, '--unexpected-target', 'x86_64-none-linux'], this.options.logger);
  }
}
`,
    );
  return { root, pkg, file };
}

let loads = 0;
/** Import the copied module afresh, so a patched installer is read again; `spawn.js` stays one instance. */
const load = (file: string) => import(`${pathToFileURL(file).href}?load=${++loads}`);

/** Execute the actual copied Installer method with its subprocess dependency replaced by the fixture. */
async function packageInvocation(fixture: Awaited<ReturnType<typeof copiedInstaller>>) {
  const installer = await load(fixture.file);
  const logger = () => {};
  const stagingDir = path.join(fixture.root, "RPM staging with spaces");
  const specPath = path.join(stagingDir, "SPECS/genex.spec");
  const context = { stagingDir, specPath, options: { arch: "x86_64", vendor: "none", platform: "linux", logger } };
  await installer.Installer.prototype.createPackage.call(context);
  const spawn = await import(pathToFileURL(path.join(path.dirname(fixture.file), "spawn.js")).href);
  const calls: Array<{ command: string; args: string[]; logger: unknown }> = spawn.calls;
  return { calls, logger, specPath, stagingDir };
}

test(
  "locked RPM Installer preserves pinned library bytes without disabling other processing",
  optionalInstaller,
  async () => {
    const fixture = await copiedInstaller();
    await patchRpmInstaller(fixture.pkg);
    const { calls, logger, specPath, stagingDir } = await packageInvocation(fixture);
    assert.deepEqual(calls, [
      {
        command: "rpmbuild",
        args: [
          "--define",
          "__strip /bin/true",
          "-bb",
          specPath,
          "--target",
          "x86_64-none-linux",
          "--define",
          `_topdir ${stagingDir}`,
        ],
        logger,
      },
    ]);
  },
);

test("RPM preservation patch is idempotent and does not rewrite a patched dependency", optionalInstaller, async () => {
  const fixture = await copiedInstaller();
  await patchRpmInstaller(fixture.pkg);
  const first = await stat(fixture.file);
  assert.equal((await patchRpmInstaller(fixture.pkg)).patched, false);
  assert.equal((await stat(fixture.file)).mtimeMs, first.mtimeMs);
  const { calls } = await packageInvocation(fixture);
  assert.equal(calls[0]?.args.filter((arg) => arg === "__strip /bin/true").length, 1);
});

test("a changed RPM installer version is refused before mutation", optionalInstaller, async () => {
  const fixture = await copiedInstaller("4.1.0");
  const before = await stat(fixture.file);
  const original = await packageInvocation(fixture);
  await assert.rejects(patchRpmInstaller(fixture.pkg), /review.*version/i);
  assert.equal((await stat(fixture.file)).mtimeMs, before.mtimeMs);
  const { calls } = await packageInvocation(fixture);
  assert.deepEqual(calls.at(-1)?.args, original.calls[0]?.args);
});

test("a changed RPM invocation is refused and keeps its original behavior", optionalInstaller, async () => {
  const fixture = await copiedInstaller(undefined, true);
  await assert.rejects(patchRpmInstaller(fixture.pkg), /changed.*review/i);
  const { calls } = await packageInvocation(fixture);
  assert.equal(calls[0]?.args.includes("--unexpected-target"), true);
  assert.equal(calls[0]?.args.includes("__strip /bin/true"), false);
});

test("an absent optional RPM dependency does not stop platform builds", async () => {
  const root = await tmpDir("studio-rpm-absent-");
  assert.deepEqual(await patchRpmInstaller(path.join(root, "absent/package.json")), { patched: false, absent: true });
});
