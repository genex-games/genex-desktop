/**
 * Crate requests (extension ladder level 4): an agent asks for an extra crate for a Rust game
 * (`crates.request` from the harness, or a `[[crate_request]]` row in `genex.toml`); the person
 * alone decides, in Studio's window (`studio:crates.decide`), with build scripts and proc macros
 * approved separately. Nothing here is reachable from an agent but the request.
 *
 * On approval the host resolves the closure from the registry's index at exact versions, fetches
 * each archive through the verified download cache (named by the sha256 the index lists; the
 * agent never gets the network), runs the vendor job with no network in its own folder
 * (`crate-vendor-job.ts`), whose crate checker (`crate-check.ts`, from the shipped policy and the
 * store's cargo-deny, cargo-vet and RustSec snapshot, `crate-checker.ts`) refuses advisories,
 * licences and bans and reports the trusted sources' audits, then holds build scripts and proc
 * macros to their own approvals; and adopts the vetted closure into the profile's overlay, granted
 * to that game alone (`crate-overlay.ts`). A policy that is not the shipped one refuses before
 * anything is fetched. The build lane accepts an approved crate only for its game (`grantFor`,
 * `rust-build.ts`).
 *
 * The ledger (`requests.json` in the overlay) holds where each request stands; every request and
 * every decision is also a persisted event (`crate_request`, `crate_decision`). Decisions run one
 * at a time per profile.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CrateCheckReport,
  crateCheckReportOf,
  CrateDecision,
  type CrateDecisionInput,
  CrateRefusal,
  type CrateRequestAnswer,
  type CrateRequestParams,
  CrateRequestState,
  type CrateRequestView,
} from "../shared/crate-requests.ts";
import { CustomEvent, type CustomEventRecord, customEventData } from "../shared/custom-events.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { GameStack, stackOf } from "../shared/game-project.ts";
import { AsyncLock, atomicWriteJson, isJsonObject, readRegularFile } from "../substrate/fsx.ts";
import { GAME_CRATE_ALLOWLIST, readGenexToml } from "../substrate/genex-toml.ts";
import { parseLockClosure } from "../substrate/rust-notices.ts";
import {
  adoptVettedCrates,
  crateOverlayLayout,
  type OverlayLayout,
  overlayGrant,
} from "../substrate/toolchain-store/crate-overlay.ts";
import type { CrateChecker } from "../substrate/toolchain-store/crate-check.ts";
import {
  type ClosureCrate,
  type CrateApprovals,
  type CrateDownload,
  type CrateId,
  type CrateIndex,
  type CrateRefused,
  cachedCrateArchive,
  isCrateName,
  isCrateVersion,
  parseIndexLines,
  resolveCrateClosure,
  runCrateVendorJob,
  sparseIndexPath,
  type VendorJobCrate,
} from "../substrate/toolchain-store/crate-vendor-job.ts";
import { RUST_LOCK_LINE_FILE, rustPayloadDir } from "./core/rust-lane.ts";
import { AUDIT_LIST_MAX_BYTES, cachedAuditList, shippedCrateChecker } from "./crate-checker.ts";
import type { RustCrateGrant } from "./rust-build.ts";
import type { StudioCore } from "./studio-core.ts";

/** The request ledger's schema (`requests.json`). */
export const CRATE_LEDGER_SCHEMA = 1;
const LEDGER_SCHEMA = CRATE_LEDGER_SCHEMA;
/** The most of the ledger and the payload's lock line the host reads. */
const LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const LOCK_LINE_MAX_BYTES = 4 * 1024 * 1024;
/** The longest request id a decision may name. */
const REQUEST_ID_MAX_CHARS = 100;
/** How long one crates.io fetch (the answer and its whole body) may take. */
export const CRATE_FETCH_TIMEOUT_MS = MINUTE_MS;
/** The largest sparse-index file a request reads (a crate's every version, one JSON line each). */
export const CRATE_INDEX_MAX_BYTES = 4 * 1024 * 1024;
/** The largest `.crate` archive a request downloads (crates.io itself takes up to 10 MiB). */
export const CRATE_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
const CRATES_IO_INDEX = "https://index.crates.io/";
const CRATES_IO_DOWNLOAD = "https://static.crates.io/crates/";
/** The registry a lock names a crates.io package by. */
const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";

const MESSAGE = {
  notRust: (project: string) => `crates.request: ${project} is not a Rust game in the library`,
  allowlisted: (name: string) => `${name} is on the reviewed list: name it under [crates] in genex.toml instead`,
  badDecision: "A crate decision names one request id and approve or decline.",
  unknown: "There is no such crate request.",
  decided: "This crate request was already decided.",
  ledger: "The crate request ledger is not the host's; nothing was changed.",
  fetch: (url: string, status: number) => `${url} answered ${status}`,
  timeout: (url: string) => `${url} did not answer in time`,
  tooLarge: (url: string, max: number) => `${url} answered more than ${max} bytes`,
  notUtf8: (url: string) => `${url} answered an index that is not UTF-8`,
} as const;

/** Why a crates.io fetch was refused. Never rename a value. */
export const CrateFetchRefusal = {
  /** No answer, or no whole body, before the deadline. */
  Timeout: "timeout",
  /** A body (or a declared length) over the cap. */
  TooLarge: "too-large",
  /** Anything but 200 (404 aside for the index): a server error, a redirect. */
  Status: "status",
  /** An index file that is not UTF-8. */
  NotUtf8: "not-utf8",
} as const;
export type CrateFetchRefusal = (typeof CrateFetchRefusal)[keyof typeof CrateFetchRefusal];

/** A crates.io fetch refused, typed by `code`. */
export class CrateFetchError extends Error {
  readonly code: CrateFetchRefusal;
  constructor(code: CrateFetchRefusal, message: string) {
    super(message);
    this.name = "CrateFetchError";
    this.code = code;
  }
}

/** A crates.io fetcher's limits: its deadline and its body caps (tests make them small). */
export interface CrateFetchLimits {
  timeoutMs: number;
  indexMaxBytes: number;
  archiveMaxBytes: number;
}

const CRATE_FETCH_LIMITS: CrateFetchLimits = {
  timeoutMs: CRATE_FETCH_TIMEOUT_MS,
  indexMaxBytes: CRATE_INDEX_MAX_BYTES,
  archiveMaxBytes: CRATE_ARCHIVE_MAX_BYTES,
};

/** Where a crate request service reads and writes, and how it reaches the registry. */
export interface CrateRequestDeps {
  /** The profile's toolchain store (`layout.toolchains`): the overlay lives inside it. */
  store: string;
  /** The host's verified download cache (`layout.downloadCache`). */
  downloadCache: string;
  index: CrateIndex;
  download: CrateDownload;
  /**
   * The engine an approved closure is checked with: the shipped policy's (the real engines over the
   * store's tools, `crate-checker.ts`), or why there is none (`crate-policy-tampered`,
   * `crate-checker-unavailable`). Asked before anything is fetched.
   */
  checker: () => Promise<{ ok: true; checker: CrateChecker } | CrateRefused>;
  /** The crates the store's lock line vendors already. */
  locked: () => Promise<readonly CrateId[]>;
  /** The Rust game `project` names in the library (its folder), or null. */
  rustGame: (project: string) => Promise<{ dir: string } | null>;
  /** Every Rust game's name, for a list across games. */
  rustGames: () => Promise<readonly string[]>;
  /** Appends persisted events. */
  record: (events: CustomEventRecord[]) => Promise<void>;
  now?: () => number;
  newId?: () => string;
}

/** One request as the ledger keeps it: its view and the person's separate approvals. */
interface LedgerRecord extends CrateRequestView {
  approvals: CrateApprovals | null;
}

/** The crate request service a profile has. */
export interface CrateRequestService {
  /** An agent's request: recorded pending (or the earlier record's state). Never an approval. */
  request(params: CrateRequestParams): Promise<CrateRequestAnswer>;
  /** Every request, newest first; a game's `[[crate_request]]` rows are filed first. */
  list(project?: string): Promise<CrateRequestView[]>;
  /** The person's decision; on approval the closure is fetched, vetted and adopted. */
  decide(input: unknown): Promise<CrateRequestView>;
  /** What a build of `project` may use: the overlay crates granted to it, the approved names, the refused ones. */
  grantFor(project: string): Promise<RustCrateGrant>;
}

const viewOf = (record: LedgerRecord): CrateRequestView => {
  const { approvals: _approvals, ...view } = record;
  return view;
};
const STATES: readonly CrateRequestState[] = Object.values(CrateRequestState);
const REFUSALS: readonly CrateRefusal[] = Object.values(CrateRefusal);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const nullableBoolean = (value: unknown): value is boolean | null => value === null || typeof value === "boolean";

function approvalsOf(value: unknown): CrateApprovals | null {
  if (!isJsonObject(value)) return null;
  return { buildScripts: value.buildScripts === true, procMacros: value.procMacros === true };
}

/** A record's check report: null when it has none (older ledgers have none), undefined when it is not one. */
function ledgerCheck(value: unknown): CrateCheckReport | null | undefined {
  if (value === undefined || value === null) return null;
  return crateCheckReportOf(value) ?? undefined;
}

/** One ledger record checked field by field; null for anything else. */
function ledgerRecord(value: unknown): LedgerRecord | null {
  if (!isJsonObject(value)) return null;
  const { requestId, project, name, version, reason, licence, closureSize, buildScripts, procMacros, requestedAt } =
    value;
  const ids = typeof requestId === "string" && typeof project === "string" && typeof requestedAt === "string";
  if (!ids || !isCrateName(name) || !isCrateVersion(version)) return null;
  const state = STATES.find((known) => known === value.state);
  const refusal = REFUSALS.find((known) => known === value.refusal) ?? null;
  const refusalRead = refusal !== null || value.refusal === null;
  if (state === undefined || !refusalRead) return null;
  if (!nullableString(reason) || !nullableString(licence)) return null;
  if (!nullableBoolean(buildScripts) || !nullableBoolean(procMacros)) return null;
  if (closureSize !== null && typeof closureSize !== "number") return null;
  const check = ledgerCheck(value.check);
  if (check === undefined) return null;
  const approvals = approvalsOf(value.approvals);
  return {
    requestId,
    project,
    name,
    version,
    reason,
    state,
    licence,
    closureSize,
    buildScripts,
    procMacros,
    refusal,
    check,
    requestedAt,
    approvals,
  };
}

/** The ledger's records; none when there is no ledger yet; throws when it is not the host's. */
async function readLedger(layout: OverlayLayout): Promise<LedgerRecord[]> {
  const bytes = await readRegularFile(layout.ledger, LEDGER_MAX_BYTES).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new Error(MESSAGE.ledger);
  });
  if (bytes === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(MESSAGE.ledger);
  }
  if (!isJsonObject(value) || value.schema !== LEDGER_SCHEMA || !Array.isArray(value.requests))
    throw new Error(MESSAGE.ledger);
  const records = value.requests.map(ledgerRecord);
  if (records.some((record) => record === null)) throw new Error(MESSAGE.ledger);
  return records.filter((record) => record !== null);
}

async function writeLedger(layout: OverlayLayout, records: readonly LedgerRecord[]): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  await atomicWriteJson(layout.ledger, { schema: LEDGER_SCHEMA, requests: records });
}

/** The person's decision checked field by field; throws before anything is read for anything else. */
function decisionOf(input: unknown): CrateDecisionInput {
  if (!isJsonObject(input)) throw new Error(MESSAGE.badDecision);
  const { requestId, decision, buildScripts, procMacros } = input;
  const named = typeof requestId === "string" && requestId.length > 0 && requestId.length <= REQUEST_ID_MAX_CHARS;
  const decided = decision === CrateDecision.Approve || decision === CrateDecision.Decline;
  const flags = [buildScripts, procMacros].every((flag) => flag === undefined || typeof flag === "boolean");
  if (!named || !decided || !flags) throw new Error(MESSAGE.badDecision);
  return { requestId, decision, buildScripts: buildScripts === true, procMacros: procMacros === true };
}

/** Whether `record` is the request for `name` at `version` in `project`. */
const sameCrate = (record: LedgerRecord, project: string, name: string, version: string) =>
  record.project === project && record.name === name && record.version === version;

/** The refusals that judged nothing (the checker missing, or failing): the request waits for the person again. */
const NOTHING_JUDGED: ReadonlySet<CrateRefusal> = new Set([CrateRefusal.CheckerUnavailable, CrateRefusal.CheckFailed]);

/** One service's dependencies, overlay, decision lock, clock and ids. */
interface Ctx {
  deps: CrateRequestDeps;
  layout: OverlayLayout;
  lock: AsyncLock;
  now: () => string;
  newId: () => string;
}

/** Files a new pending request (inside the lock) and records its event. */
async function fileRequest(
  ctx: Ctx,
  records: LedgerRecord[],
  params: { project: string; name: string; version: string; reason: string | null },
): Promise<LedgerRecord> {
  const record: LedgerRecord = {
    requestId: ctx.newId(),
    ...params,
    state: CrateRequestState.Pending,
    licence: null,
    closureSize: null,
    buildScripts: null,
    procMacros: null,
    refusal: null,
    check: null,
    requestedAt: ctx.now(),
    approvals: null,
  };
  records.push(record);
  await writeLedger(ctx.layout, records);
  const { requestId, project, name, version, reason, state } = record;
  const payload = { requestId, project, name, version, reason: reason ?? undefined, state };
  await ctx.deps.record([customEventData(CustomEvent.CrateRequest, payload)]);
  return record;
}

/** Files the `[[crate_request]]` rows of `project`'s `genex.toml` not yet in the ledger. */
async function fileManifestRows(ctx: Ctx, project: string): Promise<void> {
  const game = await ctx.deps.rustGame(project);
  if (!game) return;
  const parsed = await readGenexToml(game.dir);
  if (!parsed.ok) return;
  const rows = (parsed.manifest.crateRequests ?? []).filter((row) => !GAME_CRATE_ALLOWLIST.includes(row.name));
  if (rows.length === 0) return;
  await ctx.lock.run(async () => {
    const records = await readLedger(ctx.layout);
    for (const row of rows) {
      if (records.some((record) => sameCrate(record, project, row.name, row.version))) continue;
      await fileRequest(ctx, records, { project, name: row.name, version: row.version, reason: row.reason });
    }
  });
}

async function request(ctx: Ctx, params: CrateRequestParams): Promise<CrateRequestAnswer> {
  if (!(await ctx.deps.rustGame(params.project))) throw new Error(MESSAGE.notRust(params.project));
  if (GAME_CRATE_ALLOWLIST.includes(params.name)) throw new Error(MESSAGE.allowlisted(params.name));
  return await ctx.lock.run(async () => {
    const records = await readLedger(ctx.layout);
    const { project, name, version } = params;
    const earlier = records.find((record) => sameCrate(record, project, name, version));
    const record =
      earlier ?? (await fileRequest(ctx, records, { project, name, version, reason: params.reason ?? null }));
    return { requestId: record.requestId, state: record.state, refusal: record.refusal };
  });
}

async function list(ctx: Ctx, project?: string): Promise<CrateRequestView[]> {
  const projects = project === undefined ? await ctx.deps.rustGames() : [project];
  for (const name of projects) await fileManifestRows(ctx, name);
  const records = await readLedger(ctx.layout);
  return records
    .filter((record) => project === undefined || record.project === project)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .map(viewOf);
}

/** Writes `record`'s new state into the ledger and records the decision event. */
async function settle(ctx: Ctx, record: LedgerRecord, decision: CrateDecisionInput): Promise<CrateRequestView> {
  const records = await readLedger(ctx.layout);
  const at = records.findIndex((found) => found.requestId === record.requestId);
  if (at >= 0) records[at] = record;
  await writeLedger(ctx.layout, records);
  const { project, state, refusal, check } = record;
  const payload = { ...decision, project, state, refusal, check };
  await ctx.deps.record([customEventData(CustomEvent.CrateDecision, payload)]);
  return viewOf(record);
}

/** The verified cached archive of each closure crate, or the first refusal. */
async function closureArchives(
  ctx: Ctx,
  crates: readonly ClosureCrate[],
  scratch: string,
): Promise<{ ok: true; crates: VendorJobCrate[] } | CrateRefused> {
  const found: VendorJobCrate[] = [];
  for (const crate of crates) {
    const cached = await cachedCrateArchive(ctx.deps.downloadCache, crate, ctx.deps.download, scratch);
    if (!cached.ok) return cached;
    found.push({ ...crate, archive: cached.file });
  }
  return { ok: true, crates: found };
}

/** Fetches, vets and adopts an approved request's closure; the request's new state. */
async function vendor(ctx: Ctx, record: LedgerRecord, approvals: CrateApprovals): Promise<LedgerRecord> {
  const refused = (found: CrateRefused, facts: Partial<LedgerRecord> = {}): LedgerRecord => ({
    ...record,
    ...facts,
    ...(NOTHING_JUDGED.has(found.refusal)
      ? // The checker could not run (not installed yet, offline) or failed: nothing was judged, so
        // the request waits for the person to approve again, saying why.
        { state: CrateRequestState.Pending, approvals: null }
      : { state: CrateRequestState.Refused }),
    refusal: found.refusal,
  });
  // The policy and the engine first: a tampered policy or a missing checker fetches nothing.
  const checked = await ctx.deps.checker();
  if (!checked.ok) return refused(checked);
  const root = { name: record.name, version: record.version };
  const closure = await resolveCrateClosure(ctx.deps.index, root, await ctx.deps.locked());
  if (!closure.ok) return refused(closure);
  const jobId = `${record.requestId}-${randomUUID().slice(0, 8)}`;
  const jobDir = path.join(ctx.layout.jobs, jobId);
  const scratch = path.join(ctx.layout.incoming, jobId);
  try {
    const archives = await closureArchives(ctx, closure.crates, scratch);
    if (!archives.ok) return refused(archives);
    const { checker } = checked;
    const job = await runCrateVendorJob({ jobDir, root, crates: archives.crates, approvals, checker });
    const facts = { ...job.facts, check: job.check };
    if (!job.ok) return refused(job, facts);
    const adopted = await adoptVettedCrates(ctx.layout, record.project, record.requestId, job.crates);
    if (!adopted.ok) return refused(adopted, facts);
    return { ...record, ...facts, state: CrateRequestState.Vendored, refusal: null };
  } finally {
    await rm(jobDir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

async function decide(ctx: Ctx, input: unknown): Promise<CrateRequestView> {
  const decision = decisionOf(input);
  return await ctx.lock.run(async () => {
    const record = (await readLedger(ctx.layout)).find((found) => found.requestId === decision.requestId);
    if (!record) throw new Error(MESSAGE.unknown);
    if (record.state !== CrateRequestState.Pending) throw new Error(MESSAGE.decided);
    if (decision.decision === CrateDecision.Decline) {
      const declined = { ...record, state: CrateRequestState.Refused, refusal: CrateRefusal.Declined };
      return await settle(ctx, declined, decision);
    }
    const approvals = { buildScripts: decision.buildScripts === true, procMacros: decision.procMacros === true };
    // An earlier attempt's refusal (the checker missing or failing) and report no longer stand.
    const approved = { ...record, state: CrateRequestState.Approved, approvals, refusal: null, check: null };
    await settle(ctx, approved, decision);
    try {
      return await settle(ctx, await vendor(ctx, approved, approvals), decision);
    } catch (error) {
      // The registry could not be reached (or the host's own folders failed): the request waits
      // for the person again rather than staying approved with nothing vendored.
      await settle(ctx, { ...record, approvals: null }, decision);
      throw error;
    }
  });
}

async function grantFor(ctx: Ctx, project: string): Promise<RustCrateGrant> {
  const grant = await overlayGrant(ctx.layout, project);
  if (!grant.ok) return grant;
  const records = (await readLedger(ctx.layout)).filter((record) => record.project === project);
  const approved = records.filter((record) => record.state === CrateRequestState.Vendored).map((record) => record.name);
  const refused: Record<string, CrateRefusal> = {};
  for (const record of records) if (record.refusal !== null) refused[record.name] = record.refusal;
  for (const name of approved) delete refused[name];
  const names = [...new Set([...approved, ...grant.crates.map((crate) => crate.name)])].sort();
  return { ok: true, vendor: grant.crates.length ? grant.vendor : null, crates: grant.crates, names, refused };
}

/** A crate request service over `deps`: one ledger, one overlay, one decision at a time. */
export function createCrateRequests(deps: CrateRequestDeps): CrateRequestService {
  const ctx: Ctx = {
    deps,
    layout: crateOverlayLayout(deps.store),
    lock: new AsyncLock(),
    now: () => new Date((deps.now ?? Date.now)()).toISOString(),
    newId: deps.newId ?? (() => `crq-${randomUUID()}`),
  };
  return {
    request: (params) => request(ctx, params),
    list: (project) => list(ctx, project),
    decide: (input) => decide(ctx, input),
    grantFor: (project) => grantFor(ctx, project),
  };
}

// ── The core's own ─────────────────────────────────────────────────────────────────────────────

/**
 * One crates.io fetch under `limits`: no redirect followed, the answer and its whole body inside
 * the deadline and the cap, refused typed (`CrateFetchError`) otherwise. `allow404` lets the index
 * answer that a crate is not there (null).
 */
async function fetchCapped(
  fetcher: typeof fetch,
  url: string,
  { timeoutMs, maxBytes, allow404 }: { timeoutMs: number; maxBytes: number; allow404: boolean },
): Promise<Buffer | null> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CrateFetchError(CrateFetchRefusal.Timeout, MESSAGE.timeout(url)));
    }, timeoutMs);
  });
  deadline.catch(() => {});
  try {
    const response = await Promise.race([fetcher(url, { signal: controller.signal, redirect: "error" }), deadline]);
    if (allow404 && response.status === 404) return null;
    if (response.status !== 200)
      throw new CrateFetchError(CrateFetchRefusal.Status, MESSAGE.fetch(url, response.status));
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new CrateFetchError(CrateFetchRefusal.TooLarge, MESSAGE.tooLarge(url, maxBytes));
    return await readBody(response, url, maxBytes, deadline);
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof CrateFetchError))
      throw new CrateFetchError(CrateFetchRefusal.Timeout, MESSAGE.timeout(url));
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** A response's body, read chunk by chunk and refused past `maxBytes` or at the `deadline`. */
async function readBody(response: Response, url: string, maxBytes: number, deadline: Promise<never>): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) return Buffer.concat(chunks);
      total += value.byteLength;
      if (total > maxBytes) throw new CrateFetchError(CrateFetchRefusal.TooLarge, MESSAGE.tooLarge(url, maxBytes));
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** crates.io's sparse index, read over the host's network on the person's approval only. */
export function cratesIoIndex(
  fetcher: typeof fetch = fetch,
  limits: CrateFetchLimits = CRATE_FETCH_LIMITS,
): CrateIndex {
  return {
    versions: async (name) => {
      if (!isCrateName(name)) return null;
      const url = `${CRATES_IO_INDEX}${sparseIndexPath(name)}`;
      const bytes = await fetchCapped(fetcher, url, {
        timeoutMs: limits.timeoutMs,
        maxBytes: limits.indexMaxBytes,
        allow404: true,
      });
      if (bytes === null) return null;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new CrateFetchError(CrateFetchRefusal.NotUtf8, MESSAGE.notUtf8(url));
      }
      return parseIndexLines(name, text);
    },
  };
}

/**
 * crates.io's archive download, written to `file` only once the whole capped body is in; the
 * cache checks its sha256 after. A refused fetch writes nothing.
 */
export function cratesIoDownload(
  fetcher: typeof fetch = fetch,
  limits: CrateFetchLimits = CRATE_FETCH_LIMITS,
): CrateDownload {
  return async (crate, file) => {
    const url = `${CRATES_IO_DOWNLOAD}${crate.name}/${crate.name}-${crate.version}.crate`;
    const bytes = await fetchCapped(fetcher, url, {
      timeoutMs: limits.timeoutMs,
      maxBytes: limits.archiveMaxBytes,
      allow404: false,
    });
    await writeFile(file, bytes ?? Buffer.alloc(0), { flag: "wx" });
  };
}

/** The crates.io packages the payload's lock line holds: what the store vendors already. */
export async function shippedLockedCrates(payload: string): Promise<CrateId[]> {
  const bytes = await readRegularFile(path.join(payload, RUST_LOCK_LINE_FILE), LOCK_LINE_MAX_BYTES).catch(() => null);
  if (bytes === null) return [];
  const read = parseLockClosure(bytes.toString("utf8"));
  if (!read.ok) return [];
  return read.crates
    .filter((crate) => crate.source === CRATES_IO_SOURCE)
    .map(({ name, version }) => ({ name, version }));
}

const services = new WeakMap<StudioCore, CrateRequestService>();

/**
 * The core's crate request service: its profile's store and cache, crates.io, the shipped
 * policy's checker over the store's tools (installed on the first approval) and the lock line.
 */
export function crateRequestsFor(core: StudioCore): CrateRequestService {
  const known = services.get(core);
  if (known) return known;
  const payload = rustPayloadDir(core.options.paths.resources);
  const rustGames = async () => (await core.games.list()).filter((game) => stackOf(game.shape) === GameStack.RustWgpu);
  const service = createCrateRequests({
    store: core.layout.toolchains,
    downloadCache: core.layout.downloadCache,
    index: cratesIoIndex(),
    download: cratesIoDownload(),
    checker: () =>
      shippedCrateChecker({
        payload,
        tools: (policy) => core.toolchains.crateCheckTools(policy),
        sandbox: (spec) => core.toolchains.crateCheckSandbox(spec),
        auditList: (pinned) =>
          cachedAuditList(core.layout.downloadCache, pinned, (url) =>
            fetchCapped(fetch, url, {
              timeoutMs: CRATE_FETCH_TIMEOUT_MS,
              maxBytes: AUDIT_LIST_MAX_BYTES,
              allow404: false,
            }),
          ),
      }),
    locked: () => shippedLockedCrates(payload),
    rustGame: async (project) => (await rustGames()).find((game) => game.name === project) ?? null,
    rustGames: async () => (await rustGames()).map((game) => game.name),
    record: async (events) => {
      await core.append(events);
    },
  });
  services.set(core, service);
  return service;
}
