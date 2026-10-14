/**
 * The real crate checker's host half (`cargoCrateChecker`) over fake engines: the host writes
 * everything the engines read (each source's cargo-vet store and its `CARGO` shim included) before
 * the first engine runs and nothing after, so an engine that replaces a folder of `.check/` with a
 * link never gets the host to write outside it; and every engine run asks for no domain and no
 * loopback. No real engine runs here (`crate-check-real.test.ts` runs them).
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CrateAuditSource, CrateAuditStatus } from "../../src/shared/crate-requests.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { CHECK_RUN_POLICY, cargoCrateChecker } from "../../src/substrate/toolchain-store/crate-check.ts";
import { readCratePolicy } from "../../src/substrate/toolchain-store/crate-policy.ts";
import type { VettedCrate } from "../../src/substrate/toolchain-store/crate-vendor-job.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PAYLOAD = fileURLToPath(new URL("../../native/genex-rust", import.meta.url));
const LIST = '\n[[audits.tidy]]\nwho = "Fixture"\ncriteria = "safe-to-deploy"\nversion = "1.0.0"\n';

/** What one fake run answers. */
const answer = (request: RunRequest, stdout = ""): RunResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: "",
  durationMs: 0,
  timedOut: false,
  truncated: false,
  sandboxed: true,
  command: request.command,
  cwd: request.cwd,
});

/** A job folder with one read crate, a snapshot, an audit list and a folder outside the job. */
async function job() {
  const root = await realpath(await tmpDir("crate-check-engines-"));
  const jobDir = path.join(root, "job");
  const outside = path.join(root, "outside");
  const snapshot = path.join(root, "snapshot");
  for (const dir of [jobDir, outside, path.join(snapshot, "crates", "tidy")]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(snapshot, "crates", "tidy", "RUSTSEC-0000-0000.md"), "advisory\n");
  const list = path.join(root, "mozilla.toml");
  await writeFile(list, LIST);
  const crate: VettedCrate = {
    name: "tidy",
    version: "1.0.0",
    cksum: "",
    licence: "MIT",
    licenseExpression: "MIT",
    licenseFile: null,
    buildScript: false,
    procMacro: false,
    dir: path.join(jobDir, "tidy-1.0.0"),
    digest: "",
  };
  return { root, jobDir, outside, snapshot, list, crate };
}

describe("the host writes the check folder before any engine runs, and every run closes the network", () => {
  it("never writes through a link an engine planted in .check, and asks no domain and no loopback", async () => {
    const { jobDir, outside, snapshot, list, crate } = await job();
    const read = await readCratePolicy(PAYLOAD);
    assert.ok(read.ok);
    const vetStore = path.join(jobDir, ".check", `vet-${CrateAuditSource.Mozilla}`);
    const requests: RunRequest[] = [];
    let shimBeforeDeny = false;
    const checker = cargoCrateChecker({
      tools: {
        cargoDeny: { bin: "/fake/cargo-deny", version: "0.20.2" },
        cargoVet: { bin: "/fake/cargo-vet", version: "0.10.0" },
        advisoryDb: { dir: snapshot, commit: "a".repeat(40) },
      },
      policy: read.policy,
      auditList: async (source) => (source === CrateAuditSource.Mozilla ? list : null),
      sandbox: async () => ({
        run: async (request) => {
          requests.push(request);
          if (request.command.includes("cargo-deny")) {
            shimBeforeDeny = (await lstat(path.join(vetStore, "cargo")).catch(() => null))?.isFile() === true;
            // A hostile engine: the source's store becomes a link out of the job.
            await rm(vetStore, { recursive: true, force: true });
            await symlink(outside, vetStore);
            return answer(request);
          }
          if (request.command.includes(" vet check "))
            return answer(request, JSON.stringify({ conclusion: "success", vetted_fully: [] }));
          return answer(request);
        },
        dispose: async () => {},
      }),
    });
    const verdict = await checker.check({ jobDir, root: crate, crates: [crate] });
    assert.ok(verdict.ok, JSON.stringify(verdict));
    assert.ok(shimBeforeDeny, "the store and its shim were written before cargo-deny ran");
    assert.deepEqual(await readdir(outside), [], "nothing was written through the planted link");
    assert.ok(requests.length >= 2, "cargo-deny and cargo-vet ran");
    for (const request of requests)
      assert.deepEqual(request.policy, { ...CHECK_RUN_POLICY }, `${request.label}: no domain, no loopback`);
    assert.deepEqual(CHECK_RUN_POLICY, { allowedDomains: [], allowLocalBinding: false });
    const mozilla = verdict.report.audits.find((row) => row.source === CrateAuditSource.Mozilla);
    assert.equal(mozilla?.status, CrateAuditStatus.NotAudited);
  });
});
