/**
 * The `rust-game` and `rust-mobile-game` fixtures' crate requests: a ledger in the fixture store's
 * overlay with one request in each state and outcome the person's card shows (waiting; waiting
 * again after the checker could not be installed; added with a trusted source's audit; added with
 * no audit, its notice; refused for an advisory; refused for a dependency's licence; refused for a
 * banned crate), each decided one with the report the real engines write. Nothing here ran an
 * engine: the decision itself is native and refused in a fixture profile. Written once, only into
 * a store a fixture seeded, and never over a ledger that is there.
 */
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  CrateAuditSource,
  CrateAuditStatus,
  CrateCheckEngine,
  type CrateCheckReport,
  CrateNotice,
  CrateRefusal,
  CrateRequestState,
  type CrateRequestView,
} from "../../shared/crate-requests.ts";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import { crateOverlayLayout } from "../../substrate/toolchain-store/crate-overlay.ts";
import { CRATE_LEDGER_SCHEMA } from "../crate-requests.ts";
import { FIXTURE_STORE_MARKER } from "./fixture-toolchains.ts";

/** The snapshot the fixtures' reports name: the shipped policy's, and the day it was pinned. */
const FIXTURE_ADVISORY_DB = "550efd3d587a29b2e2c2b21b17a440da4fede999";
const FIXTURE_ADVISORY_DAY = "2026-10-08";

/** Each trusted source's answer: Mozilla's as given, the others' lists not installed. */
const auditRows = (mozilla: CrateAuditStatus) =>
  Object.values(CrateAuditSource).map((source) => ({
    source,
    status: source === CrateAuditSource.Mozilla ? mozilla : CrateAuditStatus.Unavailable,
  }));

/** A report as cargo-deny 0.20.2 and cargo-vet 0.10.0 write one. */
const report = (overrides: Partial<CrateCheckReport>): CrateCheckReport => ({
  engine: CrateCheckEngine.CargoDeny,
  engineVersion: "0.20.2",
  auditEngine: CrateCheckEngine.CargoVet,
  auditEngineVersion: "0.10.0",
  advisoryDb: FIXTURE_ADVISORY_DB,
  advisoryDbDate: FIXTURE_ADVISORY_DAY,
  advisories: [],
  blocked: [],
  licenceAllowed: true,
  audits: auditRows(CrateAuditStatus.Audited),
  notice: null,
  ...overrides,
});

/** A fixture request as the ledger keeps it (no approvals recorded). */
type FixtureRequest = CrateRequestView & { approvals: null };
/** What every fixture request shares, its game named. */
type FixtureBase = Pick<
  FixtureRequest,
  "project" | "licence" | "closureSize" | "buildScripts" | "procMacros" | "refusal" | "approvals"
>;

/** The waiting requests: one never decided, one waiting again after the checker could not be installed. */
function waitingRequests(base: FixtureBase): FixtureRequest[] {
  return [
    {
      ...base,
      requestId: "crq-fixture-hecs",
      name: "hecs",
      version: "0.10.5",
      reason: "An entity store for the pond's fish, so schools can be queried by component.",
      state: CrateRequestState.Pending,
      licence: null,
      closureSize: null,
      buildScripts: null,
      procMacros: null,
      check: null,
      requestedAt: "2026-10-08T09:05:00.000Z",
    },
    {
      ...base,
      requestId: "crq-fixture-glam",
      name: "glam",
      version: "0.29.2",
      reason: "Vector maths for the boids.",
      state: CrateRequestState.Pending,
      licence: null,
      closureSize: null,
      buildScripts: null,
      procMacros: null,
      refusal: CrateRefusal.CheckerUnavailable,
      check: null,
      requestedAt: "2026-10-08T09:06:00.000Z",
    },
  ];
}

/** The decided requests, each with the report the real engines write. */
function decidedRequests(base: FixtureBase): FixtureRequest[] {
  const refusedReport = report({ auditEngine: null, auditEngineVersion: null, audits: [] });
  return [
    {
      ...base,
      requestId: "crq-fixture-fresh",
      name: "fresh",
      version: "0.1.0",
      reason: "Weather particles over the pond.",
      state: CrateRequestState.Vendored,
      licence: "MIT",
      check: report({ audits: auditRows(CrateAuditStatus.NotAudited), notice: CrateNotice.Unaudited }),
      requestedAt: "2026-10-08T09:04:00.000Z",
    },
    {
      ...base,
      requestId: "crq-fixture-smallvec",
      name: "smallvec",
      version: "1.6.0",
      reason: "Small inline lists for the fish's paths.",
      state: CrateRequestState.Refused,
      refusal: CrateRefusal.Advisory,
      check: {
        ...refusedReport,
        advisories: ["RUSTSEC-2021-0003"],
        blocked: [{ refusal: CrateRefusal.Advisory, name: "smallvec", version: "1.6.0", detail: "RUSTSEC-2021-0003" }],
      },
      requestedAt: "2026-10-08T09:03:00.000Z",
    },
    {
      ...base,
      requestId: "crq-fixture-wrapper",
      name: "wrapper",
      version: "0.1.0",
      reason: "Text layout for the score screen.",
      state: CrateRequestState.Refused,
      licence: "MIT",
      closureSize: 2,
      refusal: CrateRefusal.Licence,
      check: {
        ...refusedReport,
        licenceAllowed: false,
        blocked: [{ refusal: CrateRefusal.Licence, name: "copyleft", version: "1.0.0", detail: "GPL-3.0-only" }],
      },
      requestedAt: "2026-10-08T09:02:30.000Z",
    },
    {
      ...base,
      requestId: "crq-fixture-glow",
      name: "glow",
      version: "0.13.0",
      reason: "A GL fallback for old Macs.",
      state: CrateRequestState.Refused,
      licence: "MIT OR Apache-2.0 OR Zlib",
      refusal: CrateRefusal.Banned,
      check: {
        ...refusedReport,
        blocked: [{ refusal: CrateRefusal.Banned, name: "glow", version: "0.13.0", detail: null }],
      },
      requestedAt: "2026-10-08T09:02:00.000Z",
    },
    {
      ...base,
      requestId: "crq-fixture-tidy",
      name: "tidy",
      version: "1.0.0",
      reason: "Tidy layouts for the HUD.",
      state: CrateRequestState.Vendored,
      closureSize: 2,
      check: report({}),
      requestedAt: "2026-10-08T09:01:00.000Z",
    },
  ];
}

/** The fixture's requests for `project`, newest first. */
function fixtureRequests(project: string): FixtureRequest[] {
  const base: FixtureBase = {
    project,
    licence: "MIT OR Apache-2.0",
    closureSize: 1,
    buildScripts: false,
    procMacros: false,
    refusal: null,
    approvals: null,
  };
  return [...waitingRequests(base), ...decidedRequests(base)];
}

/** Writes the fixture's crate request ledger for `project` into `store`, a fixture's store with no ledger yet. */
export async function seedFixtureCrateRequests(store: string, project: string): Promise<void> {
  const marked = await lstat(path.join(store, FIXTURE_STORE_MARKER)).catch(() => null);
  if (!marked?.isFile()) return;
  const layout = crateOverlayLayout(store);
  if (await lstat(layout.ledger).catch(() => null)) return;
  await mkdir(layout.root, { recursive: true });
  await atomicWriteJson(layout.ledger, { schema: CRATE_LEDGER_SCHEMA, requests: fixtureRequests(project) });
}
