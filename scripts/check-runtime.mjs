import { patchSandboxRuntime } from "./patch-sandbox-runtime.mjs";
import { patchRpmInstaller } from "./patch-rpm-installer.mjs";
import { prepareTerminalHelpers } from "./terminal-runtime.mjs";
await patchSandboxRuntime();
await patchRpmInstaller();
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveElectron } from "./electron-runtime.mjs";

if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Studio development requires Node 24. Run nvm use before installing or verifying.");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let failures = 0;
try {
  const helpers = await prepareTerminalHelpers();
  const terminal = process.platform === "win32" ? "Windows ConPTY" : "Linux native PTY";
  console.log(`Terminal: ${helpers.length ? "macOS spawn-helper executable" : terminal}`);
} catch (error) {
  failures++;
  console.error(`Terminal: unavailable — ${error.message}`);
}
for (const [name, resolve, args] of [["Electron", () => resolveElectron(), ["-p", "process.versions.electron"]]]) {
  try {
    const executable = resolve();
    if (!executable) throw new Error("bundled executable missing");
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message || result.stderr || `exit ${result.status}`);
    const version = result.stdout.trim();
    if (name === "Electron" && version !== pkg.devDependencies.electron)
      throw new Error(`expected ${pkg.devDependencies.electron}; found ${version}`);
    console.log(`${name}: ${version} (${executable})`);
  } catch (error) {
    failures++;
    console.error(
      `${name}: unavailable — ${error.message}. Reinstall pinned dependencies with optional packages enabled; do not substitute a global CLI.`,
    );
  }
}
console.log(
  "App runtime installed. Codex and Claude Code are installed and updated independently; Studio checks their external executables and sign-in separately.",
);
process.exitCode = failures ? 1 : 0;
