/** Preserve pinned bundled libraries during RPM packaging; only the locked optional installer is patched. */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
/** The installer version this patch was reviewed against (package-lock.json); any other is refused. */
const LOCKED_VERSION = "4.0.0";
const ORIGINAL = `await spawn('rpmbuild', ['-bb', this.specPath, '--target', \`\${this.options.arch}-\${this.options.vendor}-\${this.options.platform}\`, '--define', \`_topdir \${this.stagingDir}\`], this.options.logger)`;
const FIXED = ORIGINAL.replace("['-bb'", "['--define', '__strip /bin/true', '-bb'");

/** The package path is injectable for owned fixture copies; default resolution stays in this checkout. */
export async function patchRpmInstaller(packageJson) {
  let pkg = packageJson;
  if (pkg === undefined) {
    try {
      // 4.0.0 exports only its entry (`src/installer.js`), not its package.json.
      pkg = path.join(path.dirname(path.dirname(require.resolve("electron-installer-redhat"))), "package.json");
    } catch (error) {
      // The RPM maker's dependency is optional and unsupported on Windows.
      if (error.code === "MODULE_NOT_FOUND") return { patched: false, absent: true };
      throw error;
    }
  }
  let metadata;
  try {
    metadata = JSON.parse(await readFile(pkg, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { patched: false, absent: true };
    throw error;
  }
  if (metadata.name !== "electron-installer-redhat" || metadata.version !== LOCKED_VERSION)
    throw new Error("Review the RPM preservation patch before changing electron-installer-redhat version");
  const file = path.join(path.dirname(pkg), "src/installer.js");
  const source = await readFile(file, "utf8");
  const originalCount = source.split(ORIGINAL).length - 1;
  const fixedCount = source.split(FIXED).length - 1;
  if (originalCount === 0 && fixedCount === 1) return { patched: false, absent: false };
  if (originalCount !== 1 || fixedCount !== 0)
    throw new Error("RPM package invocation changed; preservation patch requires review");
  // Disable only the strip executable macro. Other RPM postprocessing still runs.
  await writeFile(file, source.replace(ORIGINAL, FIXED));
  return { patched: true, absent: false };
}
