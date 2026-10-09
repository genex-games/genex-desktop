/**
 * The main bundle loads heavy packages on first use: a static import of one runs
 * before the first window on every launch, so the build refuses it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { DEFERRED_PACKAGES, mainStartupReport } from "../../scripts/main-build.mjs";

async function mainBundle(contents: string) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), sourcefile: "src/main/index.ts", loader: "ts" },
    bundle: true,
    write: false,
    outfile: "main.mjs",
    metafile: true,
    logLevel: "silent",
    platform: "node",
    format: "esm",
    external: ["electron", ...DEFERRED_PACKAGES],
  });
  // `stdin` has no entry point name; give the output the one the build reports on.
  for (const output of Object.values(result.metafile.outputs)) output.entryPoint = "src/main/index.ts";
  return result.metafile;
}

test("a static import of a deferred package anywhere in main fails the build", async () => {
  for (const spec of [
    "@anthropic-ai/sandbox-runtime",
    "@modelcontextprotocol/sdk/client/auth.js",
    "@modelcontextprotocol/sdk/validation/ajv",
    "@anthropic-ai/claude-agent-sdk",
  ]) {
    const metafile = await mainBundle(`import * as m from "${spec}"; console.log(m);`);
    assert.throws(() => mainStartupReport(metafile), /on first use/, spec);
  }
});

test("main may load deferred packages on first use and import Electron and Node at the top", async () => {
  const metafile = await mainBundle(
    `import { app } from "electron"; import path from "node:path";
     export async function later() { return (await import("@anthropic-ai/sandbox-runtime")).SandboxManager; }
     console.log(app, path, later);`,
  );
  assert.deepEqual(mainStartupReport(metafile)?.eagerExternals, ["electron", "node:path"]);
});
