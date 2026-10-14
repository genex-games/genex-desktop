/**
 * The C++ lane in Live (M1 L4), in an owned `studio:dev` fixture profile over the `cpp-game`
 * fixture, with no provider calls: create a C++ game from the dialog, see its web build, edit and
 * rebuild, see a compile error's diagnostic, resize the slot; then the Mac-only game's status card
 * and the destination badges.
 *
 * `--store dev` links the fixture's toolchain store to an APFS clone (`cp -c -R`) of the developer's
 * real one (`$GENEX_DEV_TOOLCHAINS/dev-store`, `GENEX_FIXTURE_TOOLCHAIN_STORE`) in this runner's own
 * temporary folder, whose `current-lock.json` is this worktree's lock (`devStoreLockFile`: the
 * dev store's lock is per worktree). The real lane builds the real template with the real emcc in
 * Live, and the build time is recorded. The app never sees the shared store, nothing writes its
 * `current-lock.json`, and the clone is removed afterwards.
 *
 * Then, on the same build, the native lane's stage layout (`run-native-card-ui.mjs`, suite `layout`)
 * in a `native-game` profile, the cpp-game fixture with pong-mac's window running: the Live status
 * card beside the native card, Publish per destination, and the Toolchain sheet for a stale prewarm;
 * and suite `cross` in a `cross-game` profile: pong-cross's Windows and Linux badges read their checks.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { writeJson } from "../../scripts/studio-dev/files.mjs";
import { allocateProfile, assertStopped } from "../../scripts/studio-dev/ownership.mjs";
import { devStoreLockFile } from "../helpers/dev-toolchains.ts";
import { runNativeDriver } from "./run-native-card-ui.mjs";

const root = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const storeAt = process.argv.indexOf("--store");
const store = storeAt >= 0 ? process.argv[storeAt + 1] : "fixture";
if (!["fixture", "dev"].includes(store)) throw new Error("--store takes fixture or dev");
const REAL = store === "dev";
/** How long the whole run may take: the stub builds at once, a cold emcc build of the template does not. */
const RUN_TIMEOUT_MS = REAL ? 25 * 60_000 : 6 * 60_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;

/** The developer's real store, which `--store dev` requires (never downloaded here); it is only read. */
function devStore() {
  const toolchains = process.env.GENEX_DEV_TOOLCHAINS || path.join(root, ".studio-dev", "toolchains");
  const dir = path.join(toolchains, "dev-store");
  if (!fs.existsSync(path.join(dir, "current-lock.json")))
    throw new Error(`--store dev: no dev store at ${dir}; build it with scripts/toolchains/dev-store.ts first`);
  return fs.realpathSync(dir);
}

/**
 * An APFS clone of the dev store in this runner's own temporary folder, with this worktree's lock
 * as its `current-lock.json`: what the app is pointed at. Clones share the store's blocks, so the
 * copy costs metadata only. Answers the clone and the folder to remove afterwards.
 */
function cloneDevStore() {
  const source = devStore();
  const lockFile = devStoreLockFile(process.env, root);
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  if (typeof lock?.digest !== "string") throw new Error(`--store dev: ${lockFile} holds no lock`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "genex-cpp-web-store-"));
  const clone = path.join(temp, "dev-store");
  execFileSync("/bin/cp", ["-c", "-R", source, clone], { stdio: "inherit" });
  // The clone's own file: written by replacing the link-free copy, never through to the shared store.
  const current = path.join(clone, "current-lock.json");
  fs.rmSync(current, { force: true });
  fs.writeFileSync(current, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`--store dev: clone of ${source} at ${clone}, lock ${lock.digest.slice(0, 12)} from ${lockFile}`);
  return { clone, temp };
}

const id = `cpp-web-${REAL ? "dev-" : ""}${randomUUID().slice(0, 8)}`;
const buildId = `b-${randomUUID()}`;
const cloned = REAL ? cloneDevStore() : null;
const env = cloned ? { ...fixtureElectronEnv(), GENEX_FIXTURE_TOOLCHAIN_STORE: cloned.clone } : fixtureElectronEnv();
const owner = allocateProfile(root, id, "fixture", "cpp-game");
const out = path.join(root, ".studio-dev/evidence", id);
fs.mkdirSync(out, { recursive: true });

async function run(exe, args, childEnv, timeoutMs) {
  const child = spawn(exe, args, { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", (data) => process.stderr.write(data));
  try {
    return await new Promise((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The C++ lane's L4 in its own profile: the build, then the driver; the clone goes whatever happens. */
async function runCppDriver() {
  try {
    if (
      (await run(process.execPath, ["scripts/build.mjs", `--dev-build=${buildId}`], process.env, BUILD_TIMEOUT_MS)) !==
      0
    )
      throw new Error("the C++ web L4 build failed");
    writeJson(path.join(owner.root, "launch.json"), { version: 1, profileId: id, ownerId: owner.ownerId, buildId });
    return await run(
      resolveElectron(root),
      fixtureElectronArgs([
        fileURLToPath(new URL("./cpp-web-ui-driver.mjs", import.meta.url)),
        `--studio-dev-launch=${path.join(owner.root, "launch.json")}`,
        `--cpp-main=${path.join(root, ".studio-dev/builds", buildId, "main/main.mjs")}`,
        `--cpp-out=${out}`,
        `--cpp-store=${store}`,
      ]),
      env,
      RUN_TIMEOUT_MS,
    );
  } finally {
    // The runner's own temporary folder: the shared store was only read.
    if (cloned) fs.rmSync(cloned.temp, { recursive: true, force: true });
  }
}

const code = await runCppDriver();
const reportFile = path.join(out, "report.json");
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : { checks: [] };
console.log(`C++ web L4 (${store} store): ${report.checks.filter((check) => check.ok).length}/${report.checks.length}`);
if (report.timings) console.log(`timings: ${JSON.stringify(report.timings)}`);
console.log(reportFile);
assertStopped(owner);
const failed = code !== 0 || report.checks.length === 0 || report.checks.some((check) => !check.ok);
if (failed) process.exitCode = 1;
for (const suite of ["layout", "cross"]) {
  const native = await runNativeDriver(suite, { buildId });
  if (!native.ok) process.exitCode = 1;
}
