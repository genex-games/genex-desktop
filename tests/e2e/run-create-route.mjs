import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";

/** The Create Live route in a real Electron (`create-route-electron.ts`). */
const output = path.resolve(process.env.STUDIO_CREATE_ROUTE_OUTPUT ?? ".studio-dev/evidence/create-route");
await mkdir(output, { recursive: true });
const entry = path.join(output, "fixture.mjs");
await build({
  entryPoints: ["tests/e2e/create-route-electron.ts"],
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
});
const child = spawn(resolveElectron(), fixtureElectronArgs([entry]), {
  stdio: "inherit",
  env: { ...fixtureElectronEnv(), STUDIO_CREATE_ROUTE_REPORT: path.join(output, "report.json") },
});
const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", reject);
  });
} finally {
  clearTimeout(timer);
}
