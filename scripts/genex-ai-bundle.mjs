import path from "node:path";
import { GENEX_AI_VENDOR } from "../src/shared/genex.ts";

/**
 * How `genex-ai` (src/page/ai) is bundled: one minified ES module a game imports by its import-map
 * name ("genex-ai") from the app's vendor folder (`GENEX_AI_VENDOR.Entry`). It imports nothing: its
 * platform lane calls the embed SDK the page's connect module connected.
 * `tests/conformance/genex-ai-bundle.test.ts` builds it with these same options.
 *
 * @param {string} root the checkout
 * @param {string} outRoot the folder that holds `vendor/` (the build's `resources`)
 * @returns {import("esbuild").BuildOptions & { metafile: true }}
 */
export function genexAiBundle(root, outRoot) {
  return {
    entryPoints: [path.join(root, "src/page/ai/index.ts")],
    outfile: path.join(outRoot, "vendor", GENEX_AI_VENDOR.Entry),
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    minify: true,
    sourcemap: true,
    metafile: true,
    logLevel: "info",
  };
}
