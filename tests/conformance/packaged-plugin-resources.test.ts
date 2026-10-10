import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { verifyPackagedPluginResources } from "../e2e/packaged-plugin-resources.mjs";
import { tmpDir } from "../helpers/tmp.ts";

const BACKEND = `import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('./editor-package', import.meta.url));
export const activate = () => ({
  async action(name, args, ctx) {
    if (name !== 'install-bridge') throw new Error('unexpected action');
    const target = path.join(ctx.directory, 'Packages/com.genex.unity-bridge');
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
    const file = path.join(ctx.directory, 'Packages/manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.dependencies['com.genex.unity-bridge'] = 'file:com.genex.unity-bridge';
    await writeFile(file, JSON.stringify(manifest));
    return { installed: true };
  }
});
`;

async function fixture() {
  const root = await tmpDir("packaged-plugin-");
  const resources = path.join(root, "package", "resources", "app.asar.unpacked", "dist", "resources");
  const source = path.join(root, "src", "plugins", "unity");
  const built = path.join(root, "dist", "resources", "plugins", "unity");
  const unity = path.join(resources, "plugins", "unity");
  await mkdir(path.join(source, "editor-package", "Editor"), { recursive: true });
  const manifest = { id: "unity", apiVersion: 3, backend: "backend.mjs", actions: [{ name: "install-bridge" }] };
  await writeFile(path.join(source, "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(source, "editor-package", "package.json"),
    JSON.stringify({ name: "com.genex.unity-bridge", version: "0.1.0" }),
  );
  await writeFile(path.join(source, "editor-package", "Editor", "Bridge.cs"), "public class Bridge {}\n");
  await mkdir(built, { recursive: true });
  await writeFile(path.join(built, "backend.mjs"), BACKEND);
  await writeFile(path.join(built, "panel.html"), "<div>Bundled panel</div>");
  await mkdir(unity, { recursive: true });
  await cp(source, unity, { recursive: true });
  await cp(built, unity, { recursive: true });
  const helperSource = path.join(root, "src", "substrate", "plugins");
  const helperTarget = path.join(resources, "windows-native");
  await mkdir(helperSource, { recursive: true });
  await mkdir(helperTarget);
  for (const file of ["windows-native.cs", "windows-native.ps1"]) {
    await writeFile(path.join(helperSource, file), "trusted synthetic helper\n");
    await cp(path.join(helperSource, file), path.join(helperTarget, file));
  }
  return { root, resources, unity, helperTarget };
}

test("packaged checks load the unpacked Unity backend and install its adjacent Editor package", async () => {
  const f = await fixture();
  const checks = await verifyPackagedPluginResources({ ...f, platform: "linux" });
  assert.equal(checks.length, 2);
  assert.ok(
    checks.every((check) => check.ok),
    JSON.stringify(checks),
  );
});

test("missing, modified and linked Unity payloads fail before any backend code runs", async () => {
  for (const fault of ["missing", "modified", "linked", "backend-modified"]) {
    const f = await fixture();
    const packageFile = path.join(f.unity, "editor-package", "Editor", "Bridge.cs");
    if (fault === "missing") await rm(packageFile);
    if (fault === "modified") await writeFile(packageFile, "unexpected bytes");
    if (fault === "linked") {
      const outside = path.join(f.root, "outside.cs");
      await cp(packageFile, outside);
      await rm(packageFile);
      await symlink(outside, packageFile);
    }
    if (fault === "backend-modified")
      await writeFile(path.join(f.unity, "backend.mjs"), "throw new Error('must not execute');");
    const checks = await verifyPackagedPluginResources({ ...f, platform: "linux" });
    assert.equal(checks[0]?.ok, false, fault);
    assert.equal(checks[1]?.ok, false, fault);
    assert.match(checks[1]?.detail ?? "", /validation failed/i);
  }
});

test("Windows resources use literal unpacked paths, validate bytes and report compiler failure", async () => {
  const f = await fixture();
  let executed = 0;
  const run = async (_binary: string, args: string[], options: { windowsHide: boolean }) => {
    executed++;
    assert.equal(options.windowsHide, true);
    assert.equal(args[args.indexOf("-Source") + 1], path.join(f.helperTarget, "windows-native.cs"));
    assert.equal(args[args.indexOf("-Script") + 1], path.join(f.helperTarget, "windows-native.ps1"));
    const probe = args[args.indexOf("-File") + 1] ?? assert.fail("probe script");
    assert.ok((await readFile(probe)).length > 0);
    return { stdout: "GENEX_NATIVE_HELPER_READY\n", stderr: "" };
  };
  const success = await verifyPackagedPluginResources({ ...f, platform: "win32", run });
  assert.ok(
    success.every((check) => check.ok),
    JSON.stringify(success),
  );
  assert.equal(executed, 1);
  const failure = await verifyPackagedPluginResources({
    ...f,
    platform: "win32",
    run: async () => {
      throw new Error("Compiler refused payload");
    },
  });
  assert.equal(failure.at(-1)?.ok, false);
  assert.match(failure.at(-1)?.detail ?? "", /Compiler refused/);
  await writeFile(path.join(f.helperTarget, "windows-native.cs"), "tampered");
  const modified = await verifyPackagedPluginResources({ ...f, platform: "win32", run });
  assert.equal(modified.at(-2)?.ok, false);
  assert.equal(modified.at(-1)?.ok, false);
  assert.equal(executed, 1, "invalid helpers are never compiled");
});
