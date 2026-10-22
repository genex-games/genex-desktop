/**
 * Import a module in a worker thread of its own, for tests that load one harness workspace after
 * another. Node never frees a module it has linked, so a whole harness imported from each fresh
 * workspace stays in the test file's heap for good: a file that loads hundreds of them runs out of
 * memory on a CI runner's smaller default heap. A worker's modules go with its isolate when it ends.
 */
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

/** What importing the module gave: each export's `typeof`, or the error that stopped it linking. */
export type IsolatedImport = { exports: Record<string, string>; error?: undefined } | { error: string };

/**
 * The worker's whole program: import the module it is handed and post its exports' types (or what
 * the export it is asked to call returns), or the error. A CommonJS script (`eval`), so its dynamic import resolves the absolute URL it is given.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.url).then(
  async (module) => parentPort.postMessage(
    workerData.call
      ? { returned: await module[workerData.call]() }
      : { exports: Object.fromEntries(Object.entries(module).map(([name, value]) => [name, typeof value])) },
  ),
  (err) => parentPort.postMessage({ error: err instanceof Error ? err.message : String(err) }),
);
`;

/** Import `file` in a worker that ends once it has answered; what it linked is freed with it. */
export function importIsolated(file: string): Promise<IsolatedImport> {
  return inWorker<IsolatedImport>(file);
}

/** Import `file` in its own worker and answer what its export `name` returns, called with nothing. */
export async function callIsolated(file: string, name: string): Promise<unknown> {
  const answer = await inWorker<{ returned: unknown; error?: undefined } | { error: string }>(file, name);
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.returned;
}

/** Run the worker's program on `file` (calling its export `call`, if named) and answer what it posts. */
async function inWorker<T>(file: string, call?: string): Promise<T> {
  // No preloads: the test runner's own (`TEST_PRELOAD`) would register test hooks inside the worker.
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { url: pathToFileURL(file).href, ...(call ? { call } : {}) },
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`the import's worker exited with ${code} before answering`)));
    });
  } finally {
    await worker.terminate();
  }
}

/** Import `file` in its own worker and throw the error that stopped it linking, as `import()` would. */
export async function linkIsolated(file: string): Promise<Record<string, string>> {
  const loaded = await importIsolated(file);
  if (loaded.error !== undefined) throw new Error(loaded.error);
  return loaded.exports;
}
