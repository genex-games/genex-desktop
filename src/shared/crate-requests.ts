/**
 * Crate requests (extension ladder level 4): an agent asks for an extra crate in a Rust game
 * (`genex.toml [crates] requested`, or `crates.request` from the harness); only the person decides,
 * in Studio's window (`studio:crates.decide`), with build scripts and proc macros approved
 * separately. An approved closure is vetted with no network and added to the profile's vendored
 * overlay. Agents request; they never approve. Each request and each decision is a persisted event.
 *
 * The shipped crate policy (`native/genex-rust/crate-policy.json`, mode `person-decides`) makes the
 * person's approval the deciding vote, except that a known RustSec advisory, a licence outside the
 * allowed set or a banned crate refuses the closure whatever was approved. Audits by trusted
 * sources are reported ({@link CrateCheckReport}) and never refuse on their own.
 */
import { CustomEvent, type CustomEventData, customPayload } from "./custom-events.ts";

/** Why a crate request was refused. Typed; the words live in the renderer. Wire values: never rename one. */
export const CrateRefusal = {
  /** The person declined it. */
  Declined: "crate-declined",
  /** The registry index has no such crate or version. */
  NotFound: "crate-not-found",
  /** The version was yanked. */
  Yanked: "crate-yanked",
  /** A RustSec advisory of the pinned snapshot affects a crate in the closure (withdrawn and unmaintained ones aside). */
  Advisory: "crate-advisory",
  /** A crate in the closure has a licence outside the allowed set, or none. */
  Licence: "crate-licence",
  /**
   * cargo-vet had no audit for a crate in the closure. Older ledgers only: under the person-decides
   * policy a missing audit is a notice ({@link CrateNotice}), never a refusal.
   */
  Unvetted: "crate-unvetted",
  /** A crate in the closure has a build script the person did not approve. */
  BuildScript: "crate-build-script",
  /** A crate in the closure is a proc macro the person did not approve. */
  ProcMacro: "crate-proc-macro",
  /** The closure would add a second version of a crate the game already vendors. */
  DuplicateVersion: "crate-duplicate-version",
  /** The profile's vendored overlay no longer matches its digest manifest. */
  OverlayTampered: "crate-overlay-tampered",
  /**
   * One of the engine's own crates (in the store's lock, off the reviewed list): a game reaches it
   * only through the genex facade, never as a direct dependency.
   */
  EngineCrate: "crate-engine-internal",
  /** A crate in the closure is one the vendored-set policy bans outright (a GL backend). */
  Banned: "crate-banned",
  /** The shipped crate policy is missing, is not the pinned one, or is not its shape: nothing is vetted. */
  PolicyTampered: "crate-policy-tampered",
  /**
   * The crate checker (cargo-deny and the advisory snapshot) is not installed and could not be
   * installed now (offline): nothing was judged, so the request waits for the person again.
   */
  CheckerUnavailable: "crate-checker-unavailable",
  /**
   * The installed checker ran and failed: it timed out, gave an answer Genex could not read, or its
   * snapshot or check folder could not be prepared. Nothing was judged; the request waits again.
   */
  CheckFailed: "crate-check-failed",
} as const;
export type CrateRefusal = (typeof CrateRefusal)[keyof typeof CrateRefusal];

/** The person's answer to a request. Wire values: never rename one. */
export const CrateDecision = {
  Approve: "approve",
  Decline: "decline",
} as const;
export type CrateDecision = (typeof CrateDecision)[keyof typeof CrateDecision];

/** Where a request stands. Wire values: never rename one. */
export const CrateRequestState = {
  /** Waiting for the person. */
  Pending: "pending",
  /** Approved; the closure is being fetched and vetted. */
  Approved: "approved",
  /** Vetted and in the profile's vendored overlay. */
  Vendored: "vendored",
  /** Declined by the person, or refused by a check (`refusal` says which). */
  Refused: "refused",
} as const;
export type CrateRequestState = (typeof CrateRequestState)[keyof typeof CrateRequestState];

/** Which program produced a verdict. Wire values: never rename one. */
export const CrateCheckEngine = {
  /** cargo-deny over the pinned advisory snapshot: advisories, licences and bans. */
  CargoDeny: "cargo-deny",
  /** cargo-vet over the trusted sources' pinned audit lists: audits, shown and never deciding. */
  CargoVet: "cargo-vet",
  /** Genex's own TypeScript copy of the rules: the fixture profiles' and the tests' engine. */
  Builtin: "builtin",
} as const;
export type CrateCheckEngine = (typeof CrateCheckEngine)[keyof typeof CrateCheckEngine];

/** The trusted audit sources: the standard cargo-vet registry imports. Wire values: never rename one. */
export const CrateAuditSource = {
  BytecodeAlliance: "bytecode-alliance",
  Embark: "embark-studios",
  Google: "google",
  Mozilla: "mozilla",
  Zcash: "zcash",
} as const;
export type CrateAuditSource = (typeof CrateAuditSource)[keyof typeof CrateAuditSource];

/** What one trusted source says of a closure. Wire values: never rename one. */
export const CrateAuditStatus = {
  /** It audited every crate in the closure for `safe-to-deploy`. */
  Audited: "audited",
  /** Its audit list is installed and leaves a crate of the closure unaudited. */
  NotAudited: "not-audited",
  /** Its audit list is not installed (or could not be read), so it was not asked. */
  Unavailable: "unavailable",
} as const;
export type CrateAuditStatus = (typeof CrateAuditStatus)[keyof typeof CrateAuditStatus];

/** What a vendored crate carries for the person's information, never a refusal. Wire values. */
export const CrateNotice = {
  /** Trusted sources were asked and none audited the whole closure: added on the person's approval alone. */
  Unaudited: "crate-unaudited",
  /** No trusted source's audit list is installed, so none was asked: added on the person's approval alone. */
  NoAuditLists: "crate-no-audit-lists",
} as const;
export type CrateNotice = (typeof CrateNotice)[keyof typeof CrateNotice];

/** The refusals a check names a crate for: an advisory, a licence or a ban. */
export type CrateBlockRefusal = typeof CrateRefusal.Advisory | typeof CrateRefusal.Licence | typeof CrateRefusal.Banned;
const BLOCK_REFUSALS: readonly CrateBlockRefusal[] = [CrateRefusal.Advisory, CrateRefusal.Licence, CrateRefusal.Banned];

/** One crate of a closure a check refused it for: the requested crate or one it brings in. */
export interface CrateBlock {
  refusal: CrateBlockRefusal;
  name: string;
  version: string;
  /** The advisory's id, or the licence expression the crate names; null when there is none (a ban, no licence). */
  detail: string | null;
}

/** One trusted source's answer about a closure. */
export interface CrateAuditRow {
  source: CrateAuditSource;
  status: CrateAuditStatus;
}

/** What the checks found in an approved closure, and which engine found it. */
export interface CrateCheckReport {
  /** The engine that checked advisories, licences and bans. */
  engine: CrateCheckEngine;
  /** Its version (`cargo-deny 0.20.2` is `0.20.2`); null for the built-in rules. */
  engineVersion: string | null;
  /** The engine that read the audits; null when no trusted source's list is installed. */
  auditEngine: CrateCheckEngine | null;
  auditEngineVersion: string | null;
  /** The RustSec snapshot's commit the advisories were read from; null when unknown. */
  advisoryDb: string | null;
  /** The day the snapshot was pinned (`YYYY-MM-DD`); null when unknown (older ledgers). */
  advisoryDbDate: string | null;
  /** The advisories that refused the closure, by id; empty when none applies. */
  advisories: string[];
  /** Each crate the closure was refused for, and why; empty when it passed (and in older ledgers). */
  blocked: CrateBlock[];
  /** Whether every crate of the closure is under an allowed licence. */
  licenceAllowed: boolean;
  /** One row per trusted source, in the policy's order; empty when the audits were not asked. */
  audits: CrateAuditRow[];
  /** Why the closure was added on the approval alone (no source audited it, or none was asked); null when one audited it. */
  notice: CrateNotice | null;
}

/** What the harness sends with `crates.request`: one crate at one version, for one game, and why. */
export interface CrateRequestParams {
  project: string;
  /** The crate's registry name. */
  name: string;
  /** An exact version, `MAJOR.MINOR.PATCH` with an optional pre-release or build suffix. */
  version: string;
  /** One sentence for the person: what the game needs it for. */
  reason?: string;
  threadId?: string;
}

/** What `crates.request` answers: the request's id and where it stands. Never an approval. */
export interface CrateRequestAnswer {
  requestId: string;
  state: CrateRequestState;
  /** Why an earlier decision on the same crate refused it; null or absent otherwise. */
  refusal?: CrateRefusal | null;
}

/** One request as Studio shows it to the person, with what the checks found. */
export interface CrateRequestView {
  requestId: string;
  project: string;
  name: string;
  version: string;
  reason: string | null;
  state: CrateRequestState;
  /** The licence expression the registry names; null until read. */
  licence: string | null;
  /** How many crates the closure adds; null until resolved. */
  closureSize: number | null;
  /** Whether a crate in the closure has a build script, or is a proc macro; null until resolved. */
  buildScripts: boolean | null;
  procMacros: boolean | null;
  refusal: CrateRefusal | null;
  /** What the checks found once an approved closure was read; null before (and in older ledgers). */
  check: CrateCheckReport | null;
  /** When it was asked, ISO 8601. */
  requestedAt: string;
}

/** The person's decision on one request (`studio:crates.decide`): build scripts and proc macros are approved separately. */
export interface CrateDecisionInput {
  requestId: string;
  decision: CrateDecision;
  /** Allow the closure's build scripts; absent or false refuses them (`crate-build-script`). */
  buildScripts?: boolean;
  /** Allow the closure's proc macros; absent or false refuses them (`crate-proc-macro`). */
  procMacros?: boolean;
}

/** The persisted `crate_request` payload. Every field optional, as old logs keep old shapes. */
export type CrateRequestPayload = Partial<Omit<CrateRequestParams, "threadId">> & {
  requestId?: string;
  state?: CrateRequestState;
  refusal?: CrateRefusal | null;
};

/** The persisted `crate_decision` payload: the person's decision, what it led to and which engine decided. */
export type CrateDecisionPayload = Partial<CrateDecisionInput> & {
  project?: string;
  state?: CrateRequestState;
  refusal?: CrateRefusal | null;
  check?: CrateCheckReport | null;
};

/** The `crate_request` record's payload, or null for any other event. */
export function crateRequestOf(data: CustomEventData): CrateRequestPayload | null {
  return customPayload(data, CustomEvent.CrateRequest);
}

/** The `crate_decision` record's payload, or null for any other event. */
export function crateDecisionOf(data: CustomEventData): CrateDecisionPayload | null {
  return customPayload(data, CustomEvent.CrateDecision);
}

const ENGINES: readonly CrateCheckEngine[] = Object.values(CrateCheckEngine);
const SOURCES: readonly CrateAuditSource[] = Object.values(CrateAuditSource);
const STATUSES: readonly CrateAuditStatus[] = Object.values(CrateAuditStatus);
const NOTICES: readonly CrateNotice[] = Object.values(CrateNotice);
/** The most advisories and audit rows a report carries. */
const REPORT_LIST_MAX = 64;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** The member of `known` equal to `value`, or undefined. */
const oneOf = <T>(known: readonly T[], value: unknown): T | undefined => known.find((item) => item === value);
const nullableText = (value: unknown): string | null | undefined =>
  value === null || typeof value === "string" ? value : undefined;
const textList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length <= REPORT_LIST_MAX && value.every((item) => typeof item === "string")
    ? [...value]
    : null;

/** One audit row read back, or null. */
function auditRowOf(value: unknown): CrateAuditRow | null {
  if (!isObject(value)) return null;
  const source = oneOf(SOURCES, value.source);
  const status = oneOf(STATUSES, value.status);
  return source && status ? { source, status } : null;
}

/** One blocked crate read back, or null. */
function blockOf(value: unknown): CrateBlock | null {
  if (!isObject(value)) return null;
  const refusal = oneOf(BLOCK_REFUSALS, value.refusal);
  const { name, version } = value;
  const detail = nullableText(value.detail);
  if (refusal === undefined || typeof name !== "string" || typeof version !== "string" || detail === undefined)
    return null;
  return { refusal, name, version, detail };
}

/** The blocked crates read back: none when absent (older ledgers), null when any is not one. */
function blocksOf(value: unknown): CrateBlock[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > REPORT_LIST_MAX) return null;
  const blocks = value.map(blockOf);
  return blocks.every((block) => block !== null) ? blocks.filter((block) => block !== null) : null;
}

/** The audit rows read back, or null when any is not one. */
function auditRowsOf(value: unknown): CrateAuditRow[] | null {
  if (!Array.isArray(value) || value.length > REPORT_LIST_MAX) return null;
  const rows = value.map(auditRowOf);
  return rows.every((row) => row !== null) ? rows.filter((row) => row !== null) : null;
}

/** A check report read back field by field (a ledger or an event); null for anything else. */
export function crateCheckReportOf(value: unknown): CrateCheckReport | null {
  if (!isObject(value)) return null;
  const engine = oneOf(ENGINES, value.engine);
  const auditEngine = value.auditEngine === null ? null : oneOf(ENGINES, value.auditEngine);
  const engineVersion = nullableText(value.engineVersion);
  const auditEngineVersion = nullableText(value.auditEngineVersion);
  const advisoryDb = nullableText(value.advisoryDb);
  // Older ledgers have no date nor blocked crates: read as unknown and none.
  const advisoryDbDate = value.advisoryDbDate === undefined ? null : nullableText(value.advisoryDbDate);
  const blocked = blocksOf(value.blocked);
  const notice = value.notice === null ? null : oneOf(NOTICES, value.notice);
  const advisories = textList(value.advisories);
  const audits = auditRowsOf(value.audits);
  const licenceAllowed = typeof value.licenceAllowed === "boolean" ? value.licenceAllowed : undefined;
  const texts = [engineVersion, auditEngineVersion, advisoryDb, advisoryDbDate].every((text) => text !== undefined);
  const lists = advisories !== null && blocked !== null && audits !== null && licenceAllowed !== undefined;
  if (engine === undefined || auditEngine === undefined || notice === undefined || !texts || !lists) return null;
  return {
    engine,
    engineVersion: engineVersion ?? null,
    auditEngine,
    auditEngineVersion: auditEngineVersion ?? null,
    advisoryDb: advisoryDb ?? null,
    advisoryDbDate: advisoryDbDate ?? null,
    advisories,
    blocked,
    licenceAllowed,
    audits,
    notice,
  };
}
