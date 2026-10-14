/** Focused settings acceptance in an owned real app with synthetic providers only. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { allocateProfile, assertStopped } from "../../scripts/studio-dev/ownership.mjs";
import { writeJson } from "../../scripts/studio-dev/files.mjs";
import { resolveElectron, fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
const root = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const id = `settings-${randomUUID().slice(0, 8)}`;
const buildId = `b-${randomUUID()}`;
// cpp-game: the game-surface game plus a pre-seeded toolchain store with one unreferenced version.
const owner = allocateProfile(root, id, "fixture", "cpp-game");
const out = path.join(root, ".studio-dev/evidence", id);
fs.mkdirSync(out, { recursive: true });
async function run(exe, args, env = process.env) {
  const child = spawn(exe, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
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
if ((await run(process.execPath, ["scripts/build.mjs", `--dev-build=${buildId}`])) !== 0)
  throw new Error("Settings build failed");
writeJson(path.join(owner.root, "launch.json"), { version: 1, profileId: id, ownerId: owner.ownerId, buildId });
const code = await run(
  resolveElectron(root),
  fixtureElectronArgs([
    fileURLToPath(new URL("./settings-ui-driver.mjs", import.meta.url)),
    `--studio-dev-launch=${path.join(owner.root, "launch.json")}`,
    `--settings-main=${path.join(root, ".studio-dev/builds", buildId, "main/main.mjs")}`,
    `--settings-out=${out}`,
  ]),
  fixtureElectronEnv(),
);
const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
for (const check of report.checks)
  console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.ok ? "" : ` — ${JSON.stringify(check.detail)}`}`);
console.log(path.join(out, "report.json"));
assertStopped(owner);
if (code !== 0 || report.checks.some((check) => !check.ok)) process.exitCode = 1;
