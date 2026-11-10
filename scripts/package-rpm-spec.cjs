/**
 * The rpm's spec template. rpmbuild strips every binary and static archive it finds in the package,
 * and its strip stops the build on an archive it cannot read: the Windows import library the
 * Unreal multiplayer plugin ships (`colyseus.lib`). Electron's binaries arrive stripped and the app's
 * own native add-ons are small, so the rpm is built without the strip step.
 *
 * The template is the rpm installer's own with that one line in front, written at build time, so
 * an update of the installer keeps its template.
 */
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Turns rpmbuild's strip into a no-op for every architecture. */
const NO_STRIP = "%global __strip /bin/true\n\n";
/** The package the rpm maker runs; its entry is `src/installer.js`. */
const INSTALLER = "electron-installer-redhat";
/** The installer's template, from the folder of its entry. */
const INSTALLER_TEMPLATE = path.join("..", "resources", "spec.ejs");

/**
 * The path of the spec template the rpm maker gets, or nothing where the rpm installer is not
 * installed (it is an optional dependency, absent on Windows).
 */
function rpmSpecTemplate() {
  let upstream;
  try {
    upstream = path.join(path.dirname(require.resolve(INSTALLER)), INSTALLER_TEMPLATE);
  } catch {
    return undefined;
  }
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "genex-rpm-spec-")), "spec.ejs");
  writeFileSync(file, NO_STRIP + readFileSync(upstream, "utf8"));
  return file;
}

module.exports = { rpmSpecTemplate };
