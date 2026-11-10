/**
 * A Windows install unpacks the Genex plugin payload under the user's profile folder, and the
 * Squirrel installer (like Explorer and most tools) refuses paths of 260 characters or more. The
 * payload is the app's deepest tree, so its longest file decides whether an install under a long
 * user name works at all.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildPlugins } from "../../scripts/build-plugins.mjs";
import { authorityDevDir } from "../../src/plugins/genex/cli.ts";
import { AUTHORITY_DEV_PACKAGE, GENEX_STUDIO_TOOLS } from "../../src/shared/genex.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Windows' MAX_PATH, which counts the terminating NUL. */
const MAX_PATH = 260;
/** The longest local account name Windows allows, which names the profile folder. */
const LONGEST_USER_NAME = "x".repeat(20);

async function relativeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

test("every Genex plugin payload file fits MAX_PATH in a Squirrel install under the longest user name", async () => {
  const resources = path.join(await tmpDir("studio-payload-"), "resources");
  await buildPlugins(process.cwd(), resources);
  const { version } = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
  const installedResources = `C:\\Users\\${LONGEST_USER_NAME}\\AppData\\Local\\genex\\app-${version}\\resources\\app.asar.unpacked\\dist\\resources\\`;
  const tooLong = (await relativeFiles(resources))
    .map((file) => installedResources + file.split(path.sep).join("\\"))
    .filter((installed) => installed.length >= MAX_PATH);
  assert.deepEqual(tooLong, []);
});

/** Files no runtime loads: TypeScript declarations and source maps. */
const NEVER_LOADED = /\.(d\.[cm]?ts|map)$/;

test("the Genex plugin payload ships no declarations or source maps, which a first launch would copy", async () => {
  const resources = path.join(await tmpDir("studio-payload-"), "resources");
  await buildPlugins(process.cwd(), resources);
  const files = await relativeFiles(path.join(resources, "plugins/genex"));
  assert.ok(files.some((file) => file.endsWith(path.join("@genex-ai", "cli-demo", "dist", "index.js"))));
  assert.deepEqual(
    files.filter((file) => NEVER_LOADED.test(file)),
    [],
  );
});

test("the Genex plugin payload carries Studio's pinned room-module toolchain, loadable from the payload alone", async () => {
  const resources = path.join(await tmpDir("studio-payload-"), "resources");
  await buildPlugins(process.cwd(), resources);
  const payload = await realpath(path.join(resources, "plugins/genex"));
  const manifest = authorityDevDir(payload);
  assert.ok(manifest, "the payload resolves the toolchain");
  const pkg = JSON.parse(await readFile(path.join(manifest, "package.json"), "utf8"));
  assert.equal(pkg.version, GENEX_STUDIO_TOOLS[AUTHORITY_DEV_PACKAGE]);
  assert.ok(isInside(payload, await realpath(manifest)), "from the payload, not the repository");
  // Its library entry and every dependency it imports resolve inside the payload.
  const lib = await import(pathToFileURL(path.join(manifest, pkg.exports["."].import)).href);
  const game = await tmpDir("studio-payload-room-");
  await mkdir(path.join(game, "server"));
  await writeFile(
    path.join(game, "server", "room.js"),
    "export default { contract: 1, config: { tickHz: 30, maxPlayers: 2 }, init: () => ({}), onJoin() {}, onLeave() {}, onInput() {}, step() {} };",
  );
  const report = await lib.validateModule({ module: path.join(game, "server", "room.js"), root: game });
  assert.equal(report.passed, true, JSON.stringify(report.failures));
  for (const dep of Object.keys(pkg.dependencies)) {
    const found = await installedBelow(manifest, dep);
    assert.ok(found && isInside(payload, found), `${dep} is installed inside the payload`);
  }
});

/** The real folder Node finds `name` in from `dir`, walking up its node_modules folders; null when none has it. */
async function installedBelow(dir: string, name: string): Promise<string | null> {
  for (let at = dir; ; at = path.dirname(at)) {
    const found = await realpath(path.join(at, "node_modules", name)).catch(() => null);
    if (found) return found;
    if (path.dirname(at) === at) return null;
  }
}
