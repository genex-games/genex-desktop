import path from "node:path";
import { LOCALES, Locale } from "../src/shared/locale.ts";

/**
 * What the main bundle may load before its first line runs. Every static `import` of an external
 * package is resolved, read and evaluated before main starts, on every launch: sandbox-runtime and
 * the MCP SDK's OAuth client and validator, imported that way, cost each launch about 80 ms warm
 * and 200 ms cold. These packages load on first use, through `await import()`.
 */

/** External packages main loads only when it needs them. */
export const DEFERRED_PACKAGES = [
  "@anthropic-ai/sandbox-runtime",
  "@anthropic-ai/claude-agent-sdk",
  "@modelcontextprotocol/sdk",
];

/** The folder beside app.mjs that holds main's language catalogs, one module per language. */
export const MAIN_CATALOG_DIR = "locales";
/** The module whose `import("./<locale>.ts")` loads one catalog on demand (`loadCatalog`). */
const CATALOG_LOADER = /[\\/]src[\\/]shared[\\/]locales[\\/]index\.ts$/;
/** A language catalog's source; the folder's loader and its list of English messages are not catalogs. */
const CATALOG_SOURCE = /(?:^|[\\/])src[\\/]shared[\\/]locales[\\/](?!index\.ts$|messages\.ts$)[^\\/]+\.ts$/;

/**
 * Main's language catalogs stay files of their own. `loadCatalog` imports one on demand, but a
 * bundle without splitting inlines all eight into app.mjs, which every launch reads and compiles
 * whatever the language: 5 MB of the file and about 10 MB of main's heap. The import becomes
 * `./locales/<locale>.mjs`, built beside app.mjs from {@link mainCatalogEntries}.
 *
 * @returns {import("esbuild").Plugin}
 */
export function mainCatalogs() {
  return {
    name: "main-catalogs",
    setup(build) {
      build.onResolve({ filter: /^\.\/[^\\/]+\.ts$/ }, ({ kind, importer, path: specifier }) => {
        if (kind !== "dynamic-import" || !CATALOG_LOADER.test(importer)) return undefined;
        return { path: `./${MAIN_CATALOG_DIR}/${path.basename(specifier, ".ts")}.mjs`, external: true };
      });
    },
  };
}

/**
 * The catalogs main can load: every language but English, whose words are the code's own.
 *
 * @param {string} root the checkout
 */
export function mainCatalogEntries(root) {
  return LOCALES.filter((locale) => locale !== Locale.English).map((locale) =>
    path.join(root, "src", "shared", "locales", `${locale}.ts`),
  );
}

/**
 * Refuse a main bundle that imports a deferred package statically or carries a language catalog;
 * report what it loads eagerly.
 *
 * @param {import("esbuild").Metafile} metafile
 */
export function mainStartupReport(metafile) {
  const entry = Object.values(metafile.outputs).find((output) => output.entryPoint === "src/main/index.ts");
  if (!entry) return null;
  const eager = entry.imports.filter((i) => i.external && i.kind === "import-statement").map((i) => i.path);
  const deferred = eager.filter((spec) => DEFERRED_PACKAGES.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`)));
  if (deferred.length)
    throw new Error(`Main must load these on first use (await import): ${[...new Set(deferred)].join(", ")}`);
  const catalogs = Object.keys(entry.inputs).filter((file) => CATALOG_SOURCE.test(file));
  if (catalogs.length) throw new Error(`Main must read language catalogs from their own files: ${catalogs.join(", ")}`);
  return { bytes: entry.bytes, eagerExternals: [...new Set(eager)].sort() };
}
