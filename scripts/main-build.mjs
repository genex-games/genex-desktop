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

/**
 * Refuse a main bundle that imports a deferred package statically; report what it loads eagerly.
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
  return { bytes: entry.bytes, eagerExternals: [...new Set(eager)].sort() };
}
