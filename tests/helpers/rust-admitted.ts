/**
 * What the Rust lane reports for an admitted `out/` (`RustLaneReport`, its receipt's `outputs`),
 * for a stand-in lane that answers a folder the test wrote: every regular file under `out`,
 * `/`-separated, with its sha256 and size, as the lane records them at admission. A Rust run is
 * assembled only from those bytes (`assembleWgpuRunDir`), so a stand-in reports them when it answers.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RustBuildReceipt, RustLaneReport } from "../../src/main/rust-build-diagnostics.ts";

/** Every regular file under `dir` (links and anything else left out), sorted by path. */
async function digestTree(dir: string, rel = ""): Promise<RustBuildReceipt["outputs"]> {
  const files: RustBuildReceipt["outputs"] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await digestTree(dir, child)));
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(dir, child));
      files.push({ path: child, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The lane's report for `out` admitted now: no refusal, no diagnostics, a receipt naming its files. */
export async function admittedReport(out: string, project = "game"): Promise<RustLaneReport> {
  const at = new Date(0).toISOString();
  const receipt: RustBuildReceipt = {
    version: 1,
    project,
    target: "macos",
    triple: "aarch64-apple-darwin",
    profile: "debug",
    lock: "0".repeat(64),
    compiler: { release: "1.99.0", commitHash: "0", host: "aarch64-apple-darwin", llvm: "21.1.2" },
    startedAt: at,
    finishedAt: at,
    steps: [],
    outputs: await digestTree(out),
  };
  return { refusal: null, diagnostics: [], receipt };
}
