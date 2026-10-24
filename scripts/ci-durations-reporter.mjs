import path from "node:path";

/**
 * A `node --test` reporter that writes, as JSON, how long each test file's top-level tests and
 * suites ran, keyed by the file's path relative to the working directory. The release keeps it so
 * the next plan can balance its rig shards by time instead of by source bytes.
 * @param {AsyncIterable<{ type: string, data: { nesting?: number, file?: string,
 *   details?: { duration_ms?: number } } }>} source
 */
export default async function* durations(source) {
  /** @type {Record<string, number>} */
  const totals = {};
  for await (const { type, data } of source) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    if (data.nesting !== 0 || !data.file) continue;
    const file = path.relative(process.cwd(), data.file).split(path.sep).join("/");
    totals[file] = (totals[file] ?? 0) + Math.max(0, Math.round(data.details?.duration_ms ?? 0));
  }
  yield `${JSON.stringify(totals, null, 2)}\n`;
}
