/**
 * The crate checker an approved crate request is vetted with in the app (person-decides policy):
 * the shipped `crate-policy.json` read as its pinned bytes, and the store's cargo-deny, cargo-vet
 * and RustSec snapshot at the recipe's pins, installed on demand by the toolchain service. A
 * policy that is not the shipped one is `crate-policy-tampered`; tools that are not there (and
 * cannot be installed) are `crate-checker-unavailable`. The app never falls back to the built-in
 * rules: those are the fixture profiles' and the tests' engine (`crate-check.ts`).
 *
 * A trusted source's audit list is read only when the policy pins its sha256: fetched once on the
 * person's approval into the host's download cache under that digest, checked each time it is read.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type CrateAuditSource, CrateRefusal } from "../shared/crate-requests.ts";
import { atomicWriteFile, readRegularFile } from "../substrate/fsx.ts";
import {
  type CrateCheckSandbox,
  type CrateChecker,
  type CrateCheckTools,
  cargoCrateChecker,
} from "../substrate/toolchain-store/crate-check.ts";
import { type CrateAuditImport, type CratePolicy, readCratePolicy } from "../substrate/toolchain-store/crate-policy.ts";
import type { CrateRefused } from "../substrate/toolchain-store/crate-vendor-job.ts";

/** The download cache's folder of audit lists, each named `<sha256>.toml`. */
const AUDIT_CACHE_FOLDER = "crate-audits";
/** The most of one audit list the host reads or downloads. */
export const AUDIT_LIST_MAX_BYTES = 16 * 1024 * 1024;

const MESSAGE = {
  noTools: "cargo-deny and the pinned advisory snapshot are not installed, and could not be installed now",
} as const;

/** The checker, or why there is none. */
export type CrateCheckerRead = { ok: true; checker: CrateChecker } | CrateRefused;

/** What the app's checker reaches. */
export interface ShippedCheckerDeps {
  /** The Rust payload folder the policy ships in (`rustPayloadDir`). */
  payload: string;
  /** The store's tools at the policy's snapshot, installing them first when missing; null when there are none. */
  tools: (policy: CratePolicy) => Promise<CrateCheckTools | null>;
  sandbox: (spec: { writes: string; reads: readonly string[] }) => Promise<CrateCheckSandbox>;
  /** One pinned audit list's local copy, verified against its sha256; null when it cannot be had. */
  auditList: (pinned: CrateAuditImport & { sha256: string }) => Promise<string | null>;
}

/** The app's crate checker over the shipped policy and the store's tools; asked before anything is fetched. */
export async function shippedCrateChecker(deps: ShippedCheckerDeps): Promise<CrateCheckerRead> {
  const read = await readCratePolicy(deps.payload);
  if (!read.ok) return read;
  const { policy } = read;
  const tools = await deps.tools(policy);
  if (tools === null) return { ok: false, refusal: CrateRefusal.CheckerUnavailable, detail: MESSAGE.noTools };
  const auditList = async (source: CrateAuditSource) => {
    const pinned = policy.audits.imports.find((found) => found.source === source);
    if (!pinned || pinned.sha256 === null) return null;
    return await deps.auditList({ ...pinned, sha256: pinned.sha256 });
  };
  const advisoryDbDate = policy.advisories.pinnedAt;
  return { ok: true, checker: cargoCrateChecker({ tools, policy, sandbox: deps.sandbox, auditList, advisoryDbDate }) };
}

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * A pinned audit list from the download cache at `cache`, or fetched once (`fetch`, the host's
 * capped fetch) and kept there under its sha256; null when the bytes do not match the pin. A
 * cached file that no longer matches is fetched again; a link in its place is never read.
 */
export async function cachedAuditList(
  cache: string,
  pinned: CrateAuditImport & { sha256: string },
  fetch: (url: string) => Promise<Buffer | null>,
): Promise<string | null> {
  const folder = path.join(cache, AUDIT_CACHE_FOLDER);
  const file = path.join(folder, `${pinned.sha256}.toml`);
  const held = await readRegularFile(file, AUDIT_LIST_MAX_BYTES).catch(() => null);
  if (held !== null && sha256Of(held) === pinned.sha256) return file;
  const bytes = await fetch(pinned.url).catch(() => null);
  if (bytes === null || sha256Of(bytes) !== pinned.sha256) return null;
  await mkdir(folder, { recursive: true });
  await atomicWriteFile(file, bytes);
  return file;
}
