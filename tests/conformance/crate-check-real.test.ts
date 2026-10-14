/**
 * The crate checker's real engines (person-decides policy) over the fixture registry: the store's
 * pinned cargo-deny reads the pinned RustSec snapshot and refuses a real vulnerability, an unsound
 * advisory, an informational notice, a licence off the list (the crate's own or a dependency's)
 * and a banned crate even though the person approved, naming the crate each time; it lets an
 * unmaintained and a withdrawn advisory through, as the policy's rule says. A licence the host
 * cannot read, or a `license-file` outside the crate, is refused before cargo-deny is asked. The pinned cargo-vet reads a trusted
 * source's audit list and its answer is only shown. Both run under the real `ProcessSandbox`,
 * writing only the job's check folder, with no cargo and no network; the verdicts name them.
 * The components are installed through the store's installer from the local pinned downloads;
 * without them the rows skip (`GENEX_REQUIRE_TOOLCHAINS=1` fails instead).
 */
import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { shippedCrateChecker } from "../../src/main/crate-checker.ts";
import { createCrateRequests } from "../../src/main/crate-requests.ts";
import {
  CrateAuditSource,
  CrateAuditStatus,
  type CrateBlock,
  CrateCheckEngine,
  CrateDecision,
  CrateNotice,
  CrateRefusal,
  CrateRequestState,
} from "../../src/shared/crate-requests.ts";
import { toolchainHostOf } from "../../src/shared/toolchain.ts";
import { cargoCrateChecker, crateCheckSandboxes } from "../../src/substrate/toolchain-store/crate-check.ts";
import { locateCrateCheckTools } from "../../src/substrate/toolchain-store/crate-check-store.ts";
import {
  CRATE_POLICY_FILE,
  type CratePolicy,
  readCratePolicy,
} from "../../src/substrate/toolchain-store/crate-policy.ts";
import { crateOverlayLayout, overlayGrant } from "../../src/substrate/toolchain-store/crate-overlay.ts";
import { directoryCrateDownload, directoryCrateIndex } from "../../src/substrate/toolchain-store/crate-vendor-job.ts";
import {
  FIXTURE_BASE_LOCK,
  HOSTILE_LICENCE_CRATES,
  writeFixtureRegistry,
} from "../fixtures/crate-registry/registry.ts";
import { installRealCrateCheck, needsCrateCheck } from "../helpers/crate-check-store.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PAYLOAD = path.join(REPO, "native", "genex-rust");
const HOST = toolchainHostOf(process.platform, process.arch);

/** A trusted source's audit list as one would publish it: an audit, a criterion and a trusted entry. */
const MOZILLA_LIST = `
# cargo-vet audits file

[criteria.fixture-reviewed]
description = "Read by the fixture's reviewer."

[[audits.tidy]]
who = "Fixture Reviewer <fixture@example.com>"
criteria = "safe-to-deploy"
version = "1.0.0"
notes = """
Small, no unsafe code.
"""

[[audits.helper]]
who = "Fixture Reviewer <fixture@example.com>"
criteria = "fixture-reviewed"
version = "0.1.0"

[[trusted.serde]]
criteria = "safe-to-deploy"
user-id = 3618
start = "2019-03-01"
end = "2027-01-01"
`;

/** One store with the real checker installed, shared by every row (the install unpacks ~20 MB). */
let shared: Promise<{ root: string; store: string; registry: string; mozilla: string }> | null = null;
function installed() {
  shared ??= (async () => {
    const root = await realpath(await tmpDir("crate-check-real-"));
    const store = path.join(root, "toolchains");
    await mkdir(store, { recursive: true });
    await installRealCrateCheck(store, path.join(root, "install-scratch"));
    const registry = await writeFixtureRegistry(path.join(root, "registry"));
    const mozilla = path.join(root, "mozilla-audits.toml");
    await writeFile(mozilla, MOZILLA_LIST);
    return { root, store, registry, mozilla };
  })();
  return shared;
}

/** What a profile's checker is: the shipped policy's real engines, or the same engines over a given policy and store. */
interface CheckerChoice {
  /** The payload folder the shipped policy is read from (default: the checkout's). */
  payload?: string;
  /** The Mozilla list the engines read, as though the policy pinned it (default: none pinned). */
  auditList?: string;
  /** Another store's tools (default: the shared store's). */
  store?: string;
}

/** The engines one choice gives, recording each sandbox they open. */
function checkerOf(
  choice: CheckerChoice,
  store: string,
  sandboxes: Array<{ writes: string; reads: readonly string[] }>,
) {
  const open = crateCheckSandboxes({ secretPaths: [], denyRead: [os.homedir()], enabled: true });
  const sandbox = async (spec: { writes: string; reads: readonly string[] }) => {
    sandboxes.push(spec);
    return await open(spec);
  };
  const tools = async (policy: CratePolicy) =>
    HOST ? await locateCrateCheckTools(choice.store ?? store, HOST, policy) : null;
  if (choice.auditList === undefined)
    return () =>
      shippedCrateChecker({ payload: choice.payload ?? PAYLOAD, tools, sandbox, auditList: async () => null });
  const list = choice.auditList;
  // The shipped policy pins no audit list yet: these rows read one as a pinned Mozilla list.
  return async () => {
    const read = await readCratePolicy(PAYLOAD);
    assert.ok(read.ok);
    const found = await tools(read.policy);
    assert.ok(found, "the checker is installed");
    const auditList = async (source: CrateAuditSource) => (source === CrateAuditSource.Mozilla ? list : null);
    return { ok: true as const, checker: cargoCrateChecker({ tools: found, policy: read.policy, sandbox, auditList }) };
  };
}

/** A profile over the shared registry with its own overlay, checked as `choice` says. */
async function profile(choice: CheckerChoice = {}) {
  const { root, store, registry } = await installed();
  const own = path.join(root, `profile-${Math.random().toString(36).slice(2)}`);
  const game = path.join(own, "games", "pond");
  await mkdir(game, { recursive: true });
  await writeFile(path.join(game, "genex.toml"), '[game]\ntitle = "Pond"\n');
  const sandboxes: Array<{ writes: string; reads: readonly string[] }> = [];
  const service = createCrateRequests({
    store: path.join(own, "toolchains"),
    downloadCache: path.join(own, "download-cache"),
    index: directoryCrateIndex(registry),
    download: directoryCrateDownload(registry),
    checker: checkerOf(choice, store, sandboxes),
    locked: async () => FIXTURE_BASE_LOCK,
    rustGame: async (project) => (project === "pond" ? { dir: game } : null),
    rustGames: async () => ["pond"],
    record: async () => {},
  });
  const decide = async (name: string, version: string, approvals: { buildScripts?: boolean } = {}) => {
    const asked = await service.request({ project: "pond", name, version });
    return await service.decide({ requestId: asked.requestId, decision: CrateDecision.Approve, ...approvals });
  };
  return { service, decide, sandboxes, layout: crateOverlayLayout(path.join(own, "toolchains")), own };
}

const COMMIT = "550efd3d587a29b2e2c2b21b17a440da4fede999";
const NONE_INSTALLED = Object.values(CrateAuditSource).map((source) => ({
  source,
  status: CrateAuditStatus.Unavailable,
}));

describe("the real engines judge an approved closure (person-decides policy)", { ...needsCrateCheck() }, () => {
  it("adds a plain crate, checked by cargo-deny over the pinned snapshot, with no audit list installed", async () => {
    const { decide, sandboxes, layout } = await profile();
    const view = await decide("tidy", "1.0.0");
    assert.equal(view.state, CrateRequestState.Vendored, JSON.stringify(view));
    const policy = await readCratePolicy(PAYLOAD);
    assert.ok(policy.ok);
    assert.equal(policy.policy.advisories.commit, COMMIT);
    assert.deepEqual(view.check, {
      engine: CrateCheckEngine.CargoDeny,
      engineVersion: "0.20.2",
      auditEngine: null,
      auditEngineVersion: null,
      advisoryDb: COMMIT,
      advisoryDbDate: "2026-10-08",
      advisories: [],
      blocked: [],
      licenceAllowed: true,
      audits: NONE_INSTALLED,
      // Flipped: this was `crate-unaudited`; no source's list is installed, so none was asked.
      notice: CrateNotice.NoAuditLists,
    });
    const grant = await overlayGrant(layout, "pond");
    assert.ok(grant.ok && grant.crates.some((crate) => crate.name === "tidy"));
    assert.equal(sandboxes.length, 1);
    assert.equal(path.basename(sandboxes[0]?.writes ?? ""), ".check", "the engines write only the job's check folder");
    assert.deepEqual(await readdir(layout.jobs).catch(() => []), [], "the job and its check folder are gone");
  });

  const rows: ReadonlyArray<{
    label: string;
    name: string;
    version: string;
    approvals?: { buildScripts?: boolean };
    state: CrateRequestState;
    refusal: CrateRefusal | null;
    advisories?: string[];
    blocked?: CrateBlock[];
  }> = [
    {
      label: "a real vulnerability, though approved",
      name: "smallvec",
      version: "1.6.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
      advisories: ["RUSTSEC-2021-0003"],
      blocked: [{ refusal: CrateRefusal.Advisory, name: "smallvec", version: "1.6.0", detail: "RUSTSEC-2021-0003" }],
    },
    {
      label: "a real vulnerability, though build scripts were approved too",
      name: "smallvec",
      version: "1.6.0",
      approvals: { buildScripts: true },
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
      advisories: ["RUSTSEC-2021-0003"],
    },
    {
      label: "an unsound advisory, though approved",
      name: "lru",
      version: "0.12.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
      advisories: ["RUSTSEC-2026-0002", "RUSTSEC-2026-0253"],
    },
    {
      label: "an informational notice, though approved",
      name: "plutonium",
      version: "0.5.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
      advisories: ["RUSTSEC-2020-0011"],
    },
    {
      label: "an unmaintained notice passes",
      name: "paste",
      version: "1.0.15",
      state: CrateRequestState.Vendored,
      refusal: null,
    },
    {
      label: "a withdrawn advisory passes",
      name: "humantime",
      version: "2.1.0",
      state: CrateRequestState.Vendored,
      refusal: null,
    },
    {
      label: "a copyleft licence",
      name: "copyleft",
      version: "1.0.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Licence,
    },
    {
      label: "no licence at all",
      name: "unlicensed",
      version: "1.0.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Licence,
    },
    {
      label: "a dependency's copyleft licence",
      name: "wrapper",
      version: "0.1.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Licence,
      blocked: [{ refusal: CrateRefusal.Licence, name: "copyleft", version: "1.0.0", detail: "GPL-3.0-only" }],
    },
    {
      label: "a banned GL backend",
      name: "glow",
      version: "0.13.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Banned,
      blocked: [{ refusal: CrateRefusal.Banned, name: "glow", version: "0.13.0", detail: null }],
    },
    {
      label: "a build script the person did not approve, after the checks passed",
      name: "buildy",
      version: "0.2.0",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.BuildScript,
    },
  ];
  for (const row of rows) {
    it(`${row.label}: ${row.refusal ?? row.state}`, async () => {
      const { decide, layout } = await profile();
      const view = await decide(row.name, row.version, row.approvals);
      assert.deepEqual([view.state, view.refusal], [row.state, row.refusal], JSON.stringify(view));
      assert.equal(view.check?.engine, CrateCheckEngine.CargoDeny, "cargo-deny gave the verdict");
      if (row.advisories) assert.deepEqual(view.check?.advisories, row.advisories);
      if (row.blocked) assert.deepEqual(view.check?.blocked, row.blocked);
      const grant = await overlayGrant(layout, "pond");
      assert.ok(grant.ok);
      assert.equal(
        grant.crates.some((crate) => crate.name === row.name),
        row.state === CrateRequestState.Vendored,
      );
    });
  }

  it("shows a trusted source's audit, read by cargo-vet, and never lets it decide", async () => {
    const { mozilla } = await installed();
    const audited = await profile({ auditList: mozilla });
    const tidy = await audited.decide("tidy", "1.0.0");
    assert.equal(tidy.state, CrateRequestState.Vendored, JSON.stringify(tidy));
    assert.equal(tidy.check?.auditEngine, CrateCheckEngine.CargoVet);
    assert.equal(tidy.check?.auditEngineVersion, "0.10.0");
    const status = (view: typeof tidy, source: CrateAuditSource) =>
      view.check?.audits.find((row) => row.source === source)?.status;
    assert.equal(status(tidy, CrateAuditSource.Mozilla), CrateAuditStatus.Audited);
    assert.equal(status(tidy, CrateAuditSource.Google), CrateAuditStatus.Unavailable);
    assert.equal(tidy.check?.notice, null);
    const fresh = await audited.decide("fresh", "0.1.0");
    assert.equal(fresh.state, CrateRequestState.Vendored, "an unaudited crate is added on the approval");
    assert.equal(status(fresh, CrateAuditSource.Mozilla), CrateAuditStatus.NotAudited);
    assert.equal(fresh.check?.notice, CrateNotice.Unaudited);
  });
});

describe("a hostile snapshot or policy fails closed", { ...needsCrateCheck() }, () => {
  it("answers crate-check-failed when the installed snapshot holds a link, adds nothing and waits", async () => {
    const { root } = await installed();
    const store = path.join(root, "hostile-store");
    await mkdir(store, { recursive: true });
    await installRealCrateCheck(store, path.join(root, "hostile-scratch"));
    const read = await readCratePolicy(PAYLOAD);
    assert.ok(read.ok && HOST);
    const tools = await locateCrateCheckTools(store, HOST, read.policy);
    assert.ok(tools);
    await symlink("/etc/hosts", path.join(tools.advisoryDb.dir, "crates", "planted.md"));
    const { decide, layout, sandboxes } = await profile({ store });
    const view = await decide("tidy", "1.0.0");
    // Flipped: this was `crate-checker-unavailable`; the checker is installed and its own check failed.
    assert.deepEqual([view.state, view.refusal], [CrateRequestState.Pending, CrateRefusal.CheckFailed]);
    assert.deepEqual(sandboxes, [], "no engine ran");
    const grant = await overlayGrant(layout, "pond");
    assert.ok(grant.ok && grant.crates.length === 0);
    assert.deepEqual(await readdir(layout.jobs).catch(() => []), []);
  });

  it("refuses crate-policy-tampered over a changed payload policy, before the registry is read", async () => {
    const { own } = await profile();
    const payload = path.join(own, "payload");
    await mkdir(payload, { recursive: true });
    await writeFile(path.join(payload, CRATE_POLICY_FILE), '{"schema":1,"mode":"person-decides"}\n');
    const { decide, layout } = await profile({ payload });
    const view = await decide("tidy", "1.0.0");
    assert.deepEqual([view.state, view.refusal], [CrateRequestState.Refused, CrateRefusal.PolicyTampered]);
    assert.equal(view.check, null);
    assert.deepEqual(await readdir(layout.root).then((names) => names.sort()), ["requests.json"]);
  });
});

describe("a licence the host cannot read, or a licence file outside the crate, never reaches cargo-deny", {
  ...needsCrateCheck(),
}, () => {
  for (const { name, version } of HOSTILE_LICENCE_CRATES) {
    it(`${name}: crate-licence, nothing added`, async () => {
      const { decide, layout } = await profile();
      const view = await decide(name, version);
      assert.deepEqual(
        [view.state, view.refusal],
        [CrateRequestState.Refused, CrateRefusal.Licence],
        JSON.stringify(view),
      );
      const grant = await overlayGrant(layout, "pond");
      assert.ok(grant.ok && grant.crates.length === 0, "nothing adopted");
    });
  }
});
