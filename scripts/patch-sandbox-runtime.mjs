/** Local, version-guarded fix: an absolute executable needs no subprocess PATH lookup.
 * SRT 0.0.73 otherwise runs `which /bin/bash` with a one-second timeout and reports
 * a present shell as missing under load. Policy generation and execution are untouched. */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildWindowsSandboxHelper } from "./build-windows-sandbox.mjs";
const require = createRequire(import.meta.url);
export async function patchSandboxRuntime() {
  const pkg = require.resolve("@anthropic-ai/sandbox-runtime/package.json");
  const metadata = JSON.parse(await readFile(pkg, "utf8"));
  if (metadata.version !== "0.0.73")
    throw new Error("Review the sandbox absolute-executable patch before changing sandbox-runtime version");
  await buildWindowsSandboxHelper(path.dirname(pkg));
  const file = path.join(path.dirname(pkg), "dist/utils/which.js");
  const original = await readFile(file, "utf8");
  if (original.includes("// Studio: absolute executable lookup")) return;
  const marker = "export function whichSync(bin) {";
  if (!original.includes(marker)) throw new Error("Sandbox executable lookup changed; patch requires review");
  const fixed =
    "import { accessSync, statSync, constants } from 'node:fs';\nimport { isAbsolute } from 'node:path';\n" +
    original.replace(
      marker,
      `${marker}
    // Studio: absolute executable lookup must not depend on a timed subprocess.
    if (isAbsolute(bin)) {
        try { accessSync(bin, constants.X_OK); return statSync(bin).isFile() ? bin : null; }
        catch { return null; }
    }`,
    );
  await writeFile(file, fixed);
}
