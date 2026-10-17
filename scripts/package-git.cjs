/**
 * Git for Windows in a Windows package: the build vendors it (scripts/vendor-git-for-windows.ts,
 * from scripts/build.mjs) into {@link VENDORED_GIT}, and Forge's afterCopy hook (forge.config.cjs)
 * copies it beside the app as `resources\git`, where the app looks for it
 * (`BUNDLED_GIT_DIR` in src/substrate/windows-sandbox.ts). It stays out of app.asar: Windows runs
 * no executable from inside the archive.
 */
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

/** Where the build leaves the vendored Git for a Windows package to take. */
const VENDORED_GIT = path.join(__dirname, "..", "node_modules", ".cache", "genex", "git-for-windows", "git");
/** The folder in the package's resources (src/substrate/windows-sandbox.ts `BUNDLED_GIT_DIR`). */
const BUNDLED_GIT_DIR = "git";

/**
 * Copy the vendored Git into a Windows package's resources (`buildPath` is the copied app folder,
 * `resources\app`). Other platforms ship none; a Windows package without one is refused, since
 * the app would not start on a PC without Git.
 */
async function copyBundledGit(buildPath, platform, vendored = VENDORED_GIT) {
  if (platform !== "win32") return;
  if (!existsSync(path.join(vendored, "bin", "bash.exe")))
    throw new Error(
      `No vendored Git for Windows at ${vendored}: build with \`node scripts/build.mjs --release\` on Windows first`,
    );
  await fs.cp(vendored, path.join(path.dirname(buildPath), BUNDLED_GIT_DIR), { recursive: true });
}

module.exports = { BUNDLED_GIT_DIR, VENDORED_GIT, copyBundledGit };
