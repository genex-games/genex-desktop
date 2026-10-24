/**
 * The stage strip fits its window at every width, in both themes: an owned fixture app with a game
 * on the stage, narrowed from its usual width to its narrowest, every control in the strip measured
 * against the strip and, on Windows and Linux, against the title bar area the window's own controls
 * leave (`windowControlsOverlay`), and the window photographed with its frame at each width.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { allocateProfile, assertStopped } from "../../scripts/studio-dev/ownership.mjs";
import { writeJson } from "../../scripts/studio-dev/files.mjs";
import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";

const BUILD_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 300_000;

const root = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const id = `stage-strip-${randomUUID().slice(0, 8)}`;
const buildId = `b-${randomUUID()}`;
const owner = allocateProfile(root, id, "fixture", "game-surface");
// The Windows gate uploads its own evidence folder.
const out =
  process.platform === "win32"
    ? path.join(root, ".studio-dev/evidence/windows-tests/stage-strip")
    : path.join(root, ".studio-dev/evidence", id);
fs.mkdirSync(out, { recursive: true });

async function run(exe, args, env, timeoutMs) {
  const child = spawn(exe, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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

if ((await run(process.execPath, ["scripts/build.mjs", `--dev-build=${buildId}`], process.env, BUILD_TIMEOUT_MS)) !== 0)
  throw new Error("Stage strip build failed");
writeJson(path.join(owner.root, "launch.json"), { version: 1, profileId: id, ownerId: owner.ownerId, buildId });
const code = await run(
  resolveElectron(root),
  fixtureElectronArgs([
    fileURLToPath(new URL("./stage-strip-fit-driver.mjs", import.meta.url)),
    `--studio-dev-launch=${path.join(owner.root, "launch.json")}`,
    `--strip-main=${path.join(root, ".studio-dev/builds", buildId, "main/main.mjs")}`,
    `--strip-out=${out}`,
  ]),
  // A window the test photographs stays on screen rather than parked off every display.
  { ...fixtureElectronEnv(), STUDIO_FIXTURE_INTERACTIVE: "1" },
  RUN_TIMEOUT_MS,
);
const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
for (const check of report.checks)
  console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.ok ? "" : ` — ${JSON.stringify(check.detail)}`}`);
console.log(path.join(out, "report.json"));
assertStopped(owner);
if (code !== 0 || report.checks.some((check) => !check.ok)) process.exitCode = 1;
