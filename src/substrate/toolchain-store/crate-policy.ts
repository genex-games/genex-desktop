/**
 * The crate policy Genex ships beside the Rust payload's lock line (`crate-policy.json`, owner
 * decision 2026-10-08, option C "practical policy"): mode `person-decides`, so the person's
 * approval is the deciding vote; the pinned RustSec advisory-db snapshot (its commit and the
 * archive's sha256, which the store recipe installs as `rustsec-advisory-db`); the licence allow
 * list and the bans of `native/genex-rust/deny.toml`; and the five trusted audit sources, whose
 * answers are shown and never refuse on their own.
 *
 * The host reads the file only as the pinned bytes ({@link CRATE_POLICY_SHA256}, never through a
 * link, capped), then checks its shape and that it says what the code applies (the mode, the
 * advisory rule, audits that never block). Anything else is `crate-policy-tampered`: no closure is
 * vetted against a policy Genex did not ship. `scripts/toolchains/crate-policy.ts refresh` moves
 * the snapshot and rewrites the pins (this file's digest, the recipe's entry, `pins.md`).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { CrateAuditSource, CrateRefusal } from "../../shared/crate-requests.ts";
import { readRegularFile } from "../fsx.ts";
import type { CrateRefused } from "./crate-vendor-job.ts";

/** The policy's file name beside the payload's lock line (`<resources>/native/genex-rust/`). */
export const CRATE_POLICY_FILE = "crate-policy.json";
/** The sha256 of the shipped `crate-policy.json`: the only bytes the host vets a closure against. */
export const CRATE_POLICY_SHA256 = "156a523b73e6aed72bdb1ae763983f12a79e86ef2804b3da78c9b40b57324542";
/** The most of the policy file the host reads. */
const CRATE_POLICY_MAX_BYTES = 256 * 1024;
const SCHEMA = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The audit criteria the trusted sources are asked for. */
const AUDIT_CRITERIA = "safe-to-deploy";

/** Who decides a crate request under the policy. Wire values: never rename one. */
export const CratePolicyMode = {
  /** The person's approval decides; advisories, licences and bans still refuse. */
  PersonDecides: "person-decides",
} as const;
export type CratePolicyMode = (typeof CratePolicyMode)[keyof typeof CratePolicyMode];

/** The kinds of RustSec advisory the policy's rule names. Wire values (RustSec's own words). */
export const AdvisoryKind = {
  Vulnerability: "vulnerability",
  Unsound: "unsound",
  Notice: "notice",
  Unmaintained: "unmaintained",
  Withdrawn: "withdrawn",
} as const;
export type AdvisoryKind = (typeof AdvisoryKind)[keyof typeof AdvisoryKind];

/** The advisory kinds that refuse a closure, and the ones that pass: the rule the policy writes down. */
export const ADVISORY_RULE = {
  blocks: [AdvisoryKind.Vulnerability, AdvisoryKind.Unsound, AdvisoryKind.Notice],
  passes: [AdvisoryKind.Unmaintained, AdvisoryKind.Withdrawn],
} as const;

/**
 * Whether an advisory refuses a closure under the policy's rule: a withdrawn advisory never does,
 * nor does an informational `unmaintained` one; every other kind does (a vulnerability, `unsound`,
 * `notice`, and an informational kind the rule does not name yet: fail closed).
 */
export function advisoryBlocks(advisory: { informational?: string | null; withdrawn?: boolean }): boolean {
  if (advisory.withdrawn === true) return false;
  return advisory.informational !== AdvisoryKind.Unmaintained;
}

/** One trusted source's audit list: its URL at a pinned commit, and its sha256 once pinned (null: not asked). */
export interface CrateAuditImport {
  source: CrateAuditSource;
  url: string;
  sha256: string | null;
}

/** The shipped policy, checked. */
export interface CratePolicy {
  mode: CratePolicyMode;
  advisories: {
    /** The RustSec repository. */
    source: string;
    commit: string;
    /** The snapshot's archive (the recipe's `rustsec-advisory-db` URL), its sha256 and size. */
    archive: string;
    sha256: string;
    bytes: number;
    /** The day the snapshot was pinned, `YYYY-MM-DD`: what the person is told the advisories are as of. */
    pinnedAt: string;
    blocks: readonly AdvisoryKind[];
    passes: readonly AdvisoryKind[];
  };
  /** SPDX identifiers (and `WITH` pairs) a closure may be under: deny.toml's `[licenses] allow`. */
  licences: readonly string[];
  /** Crates refused outright: deny.toml's GL-backend bans. */
  bans: readonly string[];
  audits: { criteria: typeof AUDIT_CRITERIA; blocks: false; imports: readonly CrateAuditImport[] };
}

/** The policy, or why it was refused (always `crate-policy-tampered`). */
export type CratePolicyRead = { ok: true; policy: CratePolicy } | CrateRefused;

const MESSAGE = {
  unreadable: "the shipped crate policy is missing or is not a regular file",
  digest: "the shipped crate policy is not the pinned one",
  shape: (field: string) => `the shipped crate policy's ${field} is not what Genex applies`,
} as const;

const SOURCES: readonly CrateAuditSource[] = Object.values(CrateAuditSource);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const textList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null;
const sameList = (found: readonly string[] | null, wanted: readonly string[]): boolean =>
  found !== null && found.length === wanted.length && found.every((item, at) => item === wanted[at]);

/** Thrown inside the shape check; answered as the typed refusal. */
class PolicyShapeError extends Error {}

const tampered = (detail: string): CrateRefused => ({ ok: false, refusal: CrateRefusal.PolicyTampered, detail });

function advisoriesOf(value: unknown): CratePolicy["advisories"] {
  if (!isObject(value)) throw new PolicyShapeError(MESSAGE.shape("advisories"));
  const { source, commit, archive, sha256, bytes, pinnedAt } = value;
  const pinned = typeof commit === "string" && COMMIT.test(commit) && typeof sha256 === "string" && SHA256.test(sha256);
  const located = typeof source === "string" && typeof archive === "string" && archive.includes(String(commit));
  const sized = typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0;
  const dated = typeof pinnedAt === "string" && DAY.test(pinnedAt);
  if (!pinned || !located || !sized || !dated) throw new PolicyShapeError(MESSAGE.shape("advisories"));
  const blocks = textList(value.blocks);
  const passes = textList(value.passes);
  const rule = sameList(blocks, ADVISORY_RULE.blocks) && sameList(passes, ADVISORY_RULE.passes);
  if (!rule) throw new PolicyShapeError(MESSAGE.shape("advisory rule"));
  return {
    source,
    commit,
    archive,
    sha256,
    bytes,
    pinnedAt,
    blocks: ADVISORY_RULE.blocks,
    passes: ADVISORY_RULE.passes,
  };
}

/** One audit import, checked: a trusted source, an https URL, a sha256 or null. */
function auditImportOf(value: unknown): CrateAuditImport {
  if (!isObject(value)) throw new PolicyShapeError(MESSAGE.shape("audit import"));
  const source = SOURCES.find((known) => known === value.source);
  const url = typeof value.url === "string" && URL.canParse(value.url) ? value.url : null;
  const sha256 = value.sha256 === null || (typeof value.sha256 === "string" && SHA256.test(value.sha256));
  if (!source || url === null || new URL(url).protocol !== "https:" || !sha256)
    throw new PolicyShapeError(MESSAGE.shape("audit import"));
  return { source, url, sha256: typeof value.sha256 === "string" ? value.sha256 : null };
}

function auditsOf(value: unknown): CratePolicy["audits"] {
  if (!isObject(value) || value.criteria !== AUDIT_CRITERIA || value.blocks !== false)
    throw new PolicyShapeError(MESSAGE.shape("audits"));
  if (!Array.isArray(value.imports)) throw new PolicyShapeError(MESSAGE.shape("audits"));
  const imports = value.imports.map(auditImportOf);
  const sources = new Set(imports.map((found) => found.source));
  if (sources.size !== imports.length) throw new PolicyShapeError(MESSAGE.shape("audits"));
  return { criteria: AUDIT_CRITERIA, blocks: false, imports };
}

/** A list section (`licences.allow`, `bans.deny`), checked. */
function listOf(value: unknown, key: string, field: string): string[] {
  const list = isObject(value) ? textList(value[key]) : null;
  if (list === null || list.length === 0) throw new PolicyShapeError(MESSAGE.shape(field));
  return list;
}

/** The policy in `value`, checked field by field; throws {@link PolicyShapeError} for anything else. */
function policyOf(value: unknown): CratePolicy {
  if (!isObject(value) || value.schema !== SCHEMA) throw new PolicyShapeError(MESSAGE.shape("schema"));
  if (value.mode !== CratePolicyMode.PersonDecides) throw new PolicyShapeError(MESSAGE.shape("mode"));
  return {
    mode: CratePolicyMode.PersonDecides,
    advisories: advisoriesOf(value.advisories),
    licences: listOf(value.licences, "allow", "licences"),
    bans: listOf(value.bans, "deny", "bans"),
    audits: auditsOf(value.audits),
  };
}

/**
 * The policy in the payload folder `payload`, read as the pinned bytes (`pin`, the shipped
 * {@link CRATE_POLICY_SHA256} unless a test names another) and checked; `crate-policy-tampered`
 * for a missing, linked, oversized, changed or misshapen file. It only reads.
 */
export async function readCratePolicy(payload: string, pin: string = CRATE_POLICY_SHA256): Promise<CratePolicyRead> {
  const bytes = await readRegularFile(path.join(payload, CRATE_POLICY_FILE), CRATE_POLICY_MAX_BYTES).catch(() => null);
  if (bytes === null) return tampered(MESSAGE.unreadable);
  if (createHash("sha256").update(bytes).digest("hex") !== pin) return tampered(MESSAGE.digest);
  try {
    return { ok: true, policy: policyOf(JSON.parse(bytes.toString("utf8"))) };
  } catch (error) {
    return tampered(error instanceof PolicyShapeError ? error.message : MESSAGE.shape("JSON"));
  }
}
