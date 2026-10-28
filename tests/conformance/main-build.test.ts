/**
 * The main bundle loads heavy packages on first use: a static import of one runs
 * before the first window on every launch, so the build refuses it. Language
 * catalogs stay files of their own beside app.mjs for the same reason.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build, type Plugin } from "esbuild";
import {
  DEFERRED_PACKAGES,
  MAIN_CATALOG_DIR,
  mainCatalogEntries,
  mainCatalogs,
  mainStartupReport,
} from "../../scripts/main-build.mjs";

async function mainBundle(contents: string, plugins: Plugin[] = []) {
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
    plugins,
  });
  // `stdin` has no entry point name; give the output the one the build reports on.
  for (const output of Object.values(result.metafile.outputs)) output.entryPoint = "src/main/index.ts";
  return result.metafile;
}

/** What main's language code bundles to: the catalog loader `main/language.ts` calls. */
const LANGUAGE_LOADER = `import { loadCatalog } from "./src/shared/locales/index.ts"; console.log(loadCatalog);`;

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

test("a main bundle that carries the language catalogs fails the build", async () => {
  const metafile = await mainBundle(LANGUAGE_LOADER);
  assert.throws(() => mainStartupReport(metafile), /language catalogs/);
});

test("main imports each catalog from its own file beside app.mjs, and every one is built", async () => {
  const metafile = await mainBundle(LANGUAGE_LOADER, [mainCatalogs()]);
  assert.ok(mainStartupReport(metafile));
  const [output] = Object.values(metafile.outputs);
  const imported = output.imports.filter((i) => i.external && i.kind === "dynamic-import").map((i) => i.path);
  const built = mainCatalogEntries(process.cwd()).map(
    (entry) => `./${MAIN_CATALOG_DIR}/${path.basename(entry, ".ts")}.mjs`,
  );
  assert.deepEqual(imported.sort(), built.sort());
});
