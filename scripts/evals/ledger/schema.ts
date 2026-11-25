/**
 * Runtime validators for the ledger's closed schema (§9.1): every string is a vocabulary code or
 * matches a field-specific pattern, every object and map has a closed key set, every number is
 * finite, and a `Pinned` is a measurement, exactly `{na: true}`, or exactly `{unavailable: true,
 * reason}` with a typed `UnavailableReason`. Each shape below is bound to its contract type with
 * `Shape<T>`, so a field added to `types.ts` without a check here fails the typecheck.
 * A refusal names the dotted field and what it expected, never the value it saw.
 */
import {
  EndedHow,
  LaneModeServed,
  LaunchPath,
  TokenRole,
  type TokenUsage,
  ToolCategory,
} from "../../../src/shared/eval-lane.ts";
import { PermissionMode } from "../../../src/shared/permissions.ts";
import { EngineId } from "../../../src/shared/providers.ts";
import { CompletionPolicy, ExecutionStatus } from "../../../src/shared/run-state.ts";
import { LANE_ID_PATTERN } from "../lanes/registry.ts";
import {
  AccountExclusive,
  Axis,
  BrowserPin,
  BuildSpanKind,
  CampaignVoidReason,
  CaseExposure,
  CaseVisibility,
  CheckResult,
  Concurrency,
  ContainmentPin,
  Coverage,
  DefectCode,
  Effort,
  EvalAgent,
  GraderFamily,
  GraderVoid,
  HardwareClass,
  HarnessFailure,
  HumanPick,
  ItemVerdict,
  LaneMode,
  NetworkPin,
  NoBuild,
  NoteCode,
  PairOrder,
  PairPick,
  ProbeRow,
  RendererMode,
  RowKind,
  ServedModelRole,
  ShimMode,
  UnavailableReason,
} from "../vocabulary.ts";
import {
  CAMPAIGN_ID_PATTERN,
  DATE_PATTERN,
  HUMAN_ROW_SCHEMA,
  type HumanItemLabel,
  type HumanRow,
  INSTANT_PATTERN,
  type LedgerRow,
  MODEL_ID_PATTERN,
  OS_PATTERN,
  PAIRWISE_ROW_SCHEMA,
  type PairwiseRow,
  RUN_ID_PATTERN,
  RUN_ROW_SCHEMA,
  type RowInApp,
  type RunRow,
  SHA256_PATTERN,
  SHORT_DIGEST_PATTERN,
  SLUG_PATTERN,
  VERSION_PATTERN,
} from "./types.ts";

/** A digest a pin carries: sha256[:12] or a full sha256. */
export const DIGEST_PATTERN = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/;
/** A digest of lane flags, or `unpinned` while the lane has no argv builder yet (wave-0 decision 3). */
export const FLAGS_PIN_PATTERN = /^(?:[0-9a-f]{12}|[0-9a-f]{64}|unpinned)$/;
/** A Git commit, abbreviated or full (`appSha`, `evalSha`). */
export const GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;
/** A build id: a commit or a digest. */
export const BUILD_ID_PATTERN = /^[0-9a-f]{7,64}$/;
/** A seed as recorded (`interleaveSeed`, `blindSeed`, `placementSeed`). */
export const SEED_PATTERN = /^[0-9a-z]{1,32}$/;
/** An opaque local reviewer id: hex, never a name or an email. */
export const REVIEWER_ID_PATTERN = /^[0-9a-f]{8,32}$/;
/** An acceptance item id, `<case>-<nn>` (cases.ts numbers items from 01). */
export const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}-\d{2,3}$/;
/** A prober version, `genex-prober/6+desktop.4+cdn.<digest>`. */
export const PROBER_VERSION_PATTERN = /^[a-z0-9][a-z0-9.+/-]{0,63}$/;
/** An in-app stop code as the harness spells it. */
export const STOP_CODE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

/** A key short and plain enough to name in a refusal; anything else is named `<key>`. */
const NAMEABLE_KEY = /^[A-Za-z_$][\w$.]{0,39}$/;
const PERCENT_MAX = 100;
/** The HTTP status range a provider error may report. */
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

/** A schema refusal naming the dotted field; the message never echoes the value. */
export class LedgerSchemaError extends Error {
  readonly field: string;
  constructor(field: string, expected: string) {
    super(`ledger row ${field}: expected ${expected}`);
    this.name = "LedgerSchemaError";
    this.field = field;
  }
}

type Check = (value: unknown, at: string) => void;
/** One check per key of `T`, required or not: the key set is closed and complete. */
type Shape<T> = { readonly [K in keyof T]-?: Check };

function fail(at: string, expected: string): never {
  throw new LedgerSchemaError(at || "row", expected);
}

const fieldKey = (key: string) => (NAMEABLE_KEY.test(key) ? key : "<key>");
const child = (at: string, key: string) => (at ? `${at}.${fieldKey(key)}` : fieldKey(key));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const check =
  (test: (value: unknown) => boolean, expected: string): Check =>
  (value, at) => {
    if (!test(value)) fail(at, expected);
  };

const code = (table: Record<string, string>): Check => {
  const values: ReadonlySet<unknown> = new Set(Object.values(table));
  return check((value) => typeof value === "string" && values.has(value), "a known code");
};
const matches = (pattern: RegExp, expected: string): Check =>
  check((value) => typeof value === "string" && pattern.test(value), expected);
const literal = (expected: string): Check => check((value) => value === expected, expected);
const bool = check((value) => typeof value === "boolean", "a boolean");
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = check((value) => Number.isSafeInteger(value) && (value as number) >= 0, "a whole count");
const positive = check((value) => Number.isSafeInteger(value) && (value as number) >= 1, "a whole number from 1");
const amount = check((value) => isNumber(value) && value >= 0, "a finite number from 0");
const between = (min: number, max: number): Check =>
  check((value) => isNumber(value) && value >= min && value <= max, `a number from ${min} to ${max}`);

const nullable =
  (inner: Check): Check =>
  (value, at) => {
    if (value !== null) inner(value, at);
  };

/** An optional key: absent (undefined) passes, anything present is checked. */
const optional =
  (inner: Check): Check =>
  (value, at) => {
    if (value !== undefined) inner(value, at);
  };

const arrayOf =
  (item: Check): Check =>
  (value, at) => {
    if (!Array.isArray(value)) fail(at, "an array");
    for (const [index, entry] of value.entries()) item(entry, `${at}.${index}`);
  };

/** A closed object: no key outside `shape`, and every key of `shape` checked (a missing one is `undefined`). */
const objectOf =
  <T>(shape: Shape<T>): Check =>
  (value, at) => {
    if (!isPlainObject(value)) fail(at, "an object");
    for (const key of Object.keys(value)) if (!Object.hasOwn(shape, key)) fail(child(at, key), "no such field");
    for (const [key, inner] of Object.entries(shape) as [string, Check][]) inner(value[key], child(at, key));
  };

/** A partial map whose keys come from a closed set (or match a pattern), each value checked. */
const mapOf =
  (key: (name: string) => boolean, inner: Check): Check =>
  (value, at) => {
    if (!isPlainObject(value)) fail(at, "an object");
    for (const [name, entry] of Object.entries(value)) {
      if (!key(name)) fail(child(at, name), "a known key");
      inner(entry, child(at, name));
    }
  };
const codeKey = (table: Record<string, string>) => {
  const values: ReadonlySet<string> = new Set(Object.values(table));
  return (name: string) => values.has(name);
};

const UNAVAILABLE_REASONS: ReadonlySet<unknown> = new Set(Object.values(UnavailableReason));
const PINNED_EXPECTED = "a measurement, {na: true} or {unavailable: true, reason}";

/** Whether `value` has exactly these own keys. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isNotApplicable = (value: Record<string, unknown>) => hasExactKeys(value, ["na"]) && value.na === true;
function isUnavailable(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ["unavailable", "reason"])) return false;
  return value.unavailable === true && UNAVAILABLE_REASONS.has(value.reason);
}

/** A `Pinned<T>`: the measurement, or exactly one of the two typed stand-ins, refused at the pin itself. */
const pinned =
  (measured: Check): Check =>
  (value, at) => {
    const standIn = isPlainObject(value) && (Object.hasOwn(value, "na") || Object.hasOwn(value, "unavailable"));
    if (!standIn) return measured(value, at);
    if (!isNotApplicable(value) && !isUnavailable(value)) fail(at, PINNED_EXPECTED);
  };

const slug = matches(SLUG_PATTERN, "a slug");
const laneId = matches(LANE_ID_PATTERN, "a lane id");
const modelId = matches(MODEL_ID_PATTERN, "a model id");
const runId = matches(RUN_ID_PATTERN, "a run id");
const campaignId = matches(CAMPAIGN_ID_PATTERN, "a campaign id");
const instant = matches(INSTANT_PATTERN, "an ISO instant");
const shortDigest = matches(SHORT_DIGEST_PATTERN, "a short digest");
const digest = matches(DIGEST_PATTERN, "a digest");
const sha256 = matches(SHA256_PATTERN, "a sha256");
const seed = matches(SEED_PATTERN, "a seed");
const ms = amount;
const percent = between(0, PERCENT_MAX);
const httpStatus = check(
  (value) => Number.isSafeInteger(value) && isNumber(value) && value >= HTTP_STATUS_MIN && value <= HTTP_STATUS_MAX,
  "an HTTP status",
);
const share = between(0, 1);

const COMPLETION_POLICIES: ReadonlySet<unknown> = new Set<RowInApp["budgets"]["completionPolicy"]>(
  Object.values(CompletionPolicy),
);

const USAGE: Shape<TokenUsage> = {
  uncachedInput: count,
  cacheWrite: count,
  cacheRead: count,
  output: count,
  reasoning: count,
};
const usage = objectOf(USAGE);

type Of<K extends keyof RunRow> = NonNullable<RunRow[K]>;

const CASE: Shape<RunRow["case"]> = {
  id: slug,
  version: shortDigest,
  checklistVersion: shortDigest,
  exposure: code(CaseExposure),
  visibility: code(CaseVisibility),
};

const LANE: Shape<RunRow["lane"]> = {
  id: laneId,
  agent: code(EvalAgent),
  engine: code(EngineId),
  mode: code(LaneMode),
  modeServed: nullable(code(LaneModeServed)),
  harnessPin: matches(FLAGS_PIN_PATTERN, "a digest or unpinned"),
  network: code(NetworkPin),
  browser: code(BrowserPin),
  containment: code(ContainmentPin),
};

const MODEL: Shape<RunRow["model"]> = {
  requested: modelId,
  main: nullable(modelId),
  served: arrayOf(
    objectOf<RunRow["model"]["served"][number]>({ id: modelId, role: code(ServedModelRole), tokens: nullable(usage) }),
  ),
  effort: code(Effort),
  effortServed: pinned(code(Effort)),
};

const PINS: Shape<RunRow["pins"]> = {
  run: objectOf<RunRow["pins"]["run"]>({
    appSha: pinned(matches(GIT_SHA_PATTERN, "a commit")),
    buildId: pinned(matches(BUILD_ID_PATTERN, "a build id")),
    harnessSeedDigest: pinned(digest),
    cliVersion: pinned(matches(VERSION_PATTERN, "a version")),
    laneWrapperDigest: matches(FLAGS_PIN_PATTERN, "a digest or unpinned"),
    containmentDigest: digest,
    instructionSha: digest,
  }),
  grading: objectOf<RunRow["pins"]["grading"]>({
    proberVersion: pinned(matches(PROBER_VERSION_PATTERN, "a prober version")),
    soakMs: pinned(ms),
    graderPromptSha: pinned(digest),
    graderModels: arrayOf(modelId),
    pairwiseRubricSha: pinned(digest),
    shimMode: code(ShimMode),
    rendererMode: pinned(code(RendererMode)),
    endpointsSha: shortDigest,
  }),
  recorded: objectOf<RunRow["pins"]["recorded"]>({
    evalSha: matches(GIT_SHA_PATTERN, "a commit"),
    appDirty: bool,
    os: matches(OS_PATTERN, "an os"),
    hardwareClass: code(HardwareClass),
    concurrency: code(Concurrency),
    coRunLane: nullable(laneId),
    interleaveSeed: seed,
    accountExclusive: code(AccountExclusive),
  }),
};

const OUTCOME: Shape<RunRow["outcome"]> = {
  endedHow: code(EndedHow),
  harnessFailure: nullable(code(HarnessFailure)),
  noBuild: nullable(code(NoBuild)),
  questionsAsked: count,
  answersGiven: count,
  traceComplete: objectOf<RunRow["outcome"]["traceComplete"]>({ parseFailures: count, truncatedTail: bool }),
  providerNoise: objectOf<RunRow["outcome"]["providerNoise"]>({
    apiErrors: count,
    retries: count,
    apiErrorStatus: nullable(httpStatus),
  }),
};

const TIME: Shape<RunRow["time"]> = {
  wallMs: nullable(ms),
  toDoneMs: nullable(ms),
  firstBootMs: nullable(ms),
  firstPlayableMs: nullable(ms),
  firstPlayableResolutionMs: nullable(ms),
  firstPreviewMs: nullable(ms),
  delegationP50Ms: nullable(ms),
  builds: arrayOf(objectOf<RunRow["time"]["builds"][number]>({ kind: code(BuildSpanKind), ms })),
  coverage: code(Coverage),
};

const TOKENS: Shape<RunRow["tokens"]> = {
  ...USAGE,
  byRole: mapOf(codeKey(TokenRole), usage),
  byModel: mapOf((name) => MODEL_ID_PATTERN.test(name), usage),
  coverage: code(Coverage),
};

const CONTEXT: Shape<RunRow["context"]> = {
  leadPeakPct: nullable(percent),
  leadPeakTokens: nullable(count),
  workersPeakPct: nullable(percent),
  compactions: nullable(count),
  coverage: code(Coverage),
};

const CALLS: Shape<RunRow["calls"]> = {
  modelCalls: nullable(count),
  tools: objectOf<RunRow["calls"]["tools"]>({
    total: nullable(count),
    byCategory: mapOf(codeKey(ToolCategory), count),
  }),
  blindEditStreak: nullable(count),
  subagents: nullable(count),
  verifiedBeforeDone: nullable(bool),
  coverage: code(Coverage),
};

const COST: Shape<RunRow["cost"]> = {
  apiEquivalentUsd: pinned(amount),
  priceTable: matches(DATE_PATTERN, "a date"),
  cliReportedUsd: nullable(amount),
  billed: nullable(amount),
  quota: arrayOf(
    objectOf<RunRow["cost"]["quota"][number]>({
      windowId: slug,
      before: nullable(percent),
      after: nullable(percent),
      resetsAtBefore: nullable(instant),
      resetsAtAfter: nullable(instant),
      resetInside: bool,
    }),
  ),
};

const OUTPUT: Shape<RunRow["output"]> = {
  files: count,
  bytes: count,
  loc: count,
  hasEntry: bool,
  buildScript: bool,
  validate: code(CheckResult),
};

const PROBE: Shape<Of<"probe">> = {
  l1Gate: code(CheckResult),
  l2Gate: code(CheckResult),
  rows: mapOf(codeKey(ProbeRow), code(CheckResult)),
  firstRenderMs: nullable(ms),
  fpsMedian: nullable(amount),
  consoleErrors: nullable(count),
  soakMs: pinned(ms),
  quick: bool,
};

const CHECKLIST: Shape<Of<"checklist">> = {
  scoreAllRuns: share,
  scoreGraded: nullable(share),
  byFamily: mapOf(
    codeKey(GraderFamily),
    objectOf<{ passed: number; graded: number; inconclusive: number }>({
      passed: count,
      graded: count,
      inconclusive: count,
    }),
  ),
  inconclusiveRate: share,
  judgeSkipped: bool,
  graderVoid: nullable(code(GraderVoid)),
};

const IN_APP: Shape<Of<"inApp">> = {
  mode: code(LaneModeServed),
  launch: code(LaunchPath),
  budgets: objectOf<RowInApp["budgets"]>({
    completionPolicy: nullable(check((value) => COMPLETION_POLICIES.has(value), "a completion policy")),
    wallClockMs: nullable(ms),
    untilSatisfied: nullable(bool),
  }),
  permissionMode: code(PermissionMode),
  victory: nullable(bool),
  executionStatus: nullable(code(ExecutionStatus)),
  stopCode: nullable(matches(STOP_CODE_PATTERN, "a stop code")),
  livenessMax: nullable(count),
  scoreboard: nullable(
    objectOf<NonNullable<RowInApp["scoreboard"]>>({ passing: count, total: count, regressions: count }),
  ),
  judgeCalls: nullable(count),
  judgeTokens: nullable(usage),
  inAppRubricDigest: digest,
};

const RUN_ROW: Shape<RunRow> = {
  schema: literal(RUN_ROW_SCHEMA),
  runId,
  campaignId,
  recordedAt: instant,
  gradeSeq: positive,
  gradeId: shortDigest,
  kind: code(RowKind),
  campaignVoid: nullable(code(CampaignVoidReason)),
  supersededBy: nullable(runId),
  case: objectOf(CASE),
  lane: objectOf(LANE),
  model: objectOf(MODEL),
  pins: objectOf(PINS),
  outcome: objectOf(OUTCOME),
  time: objectOf(TIME),
  tokens: objectOf(TOKENS),
  context: objectOf(CONTEXT),
  calls: objectOf(CALLS),
  cost: objectOf(COST),
  output: objectOf(OUTPUT),
  probe: nullable(objectOf(PROBE)),
  checklist: nullable(objectOf(CHECKLIST)),
  inApp: nullable(objectOf(IN_APP)),
  digests: objectOf<RunRow["digests"]>({
    streamSha256: nullable(sha256),
    transcriptSha256: nullable(sha256),
    snapshotSha256: nullable(sha256),
    evidenceSha256: nullable(sha256),
  }),
  notes: arrayOf(code(NoteCode)),
};

const PICKS: Shape<PairwiseRow["picks"]> = {
  overall: code(PairPick),
  works: code(PairPick),
  visuals: code(PairPick),
  feel: code(PairPick),
  play: code(PairPick),
};

const PAIRWISE_ROW: Shape<PairwiseRow> = {
  schema: literal(PAIRWISE_ROW_SCHEMA),
  campaignId,
  recordedAt: instant,
  gradeSeq: positive,
  gradeId: shortDigest,
  caseId: slug,
  caseVersion: shortDigest,
  rep: count,
  axis: code(Axis),
  lanes: objectOf<PairwiseRow["lanes"]>({ first: laneId, second: laneId }),
  runIds: objectOf<PairwiseRow["runIds"]>({ first: runId, second: runId }),
  order: code(PairOrder),
  blindSeed: seed,
  family: code(GraderFamily),
  graderModel: modelId,
  sameFamily: bool,
  pairwiseRubricSha: digest,
  picks: objectOf(PICKS),
  judgeSkipped: bool,
  forfeit: optional(bool),
};

const ITEM_LABEL: Shape<HumanItemLabel> = {
  id: matches(ITEM_ID_PATTERN, "an acceptance item id"),
  verdicts: mapOf(codeKey(GraderFamily), code(ItemVerdict)),
  human: code(ItemVerdict),
};

const HUMAN_ROW: Shape<HumanRow> = {
  schema: literal(HUMAN_ROW_SCHEMA),
  campaignId,
  recordedAt: instant,
  caseId: slug,
  caseVersion: shortDigest,
  reviewerId: matches(REVIEWER_ID_PATTERN, "an opaque reviewer id"),
  runIds: objectOf<HumanRow["runIds"]>({ a: runId, b: runId }),
  placementSeed: seed,
  pick: nullable(code(HumanPick)),
  defect: code(DefectCode),
  requestSatisfied: nullable(
    objectOf<NonNullable<HumanRow["requestSatisfied"]>>({ a: code(CheckResult), b: code(CheckResult) }),
  ),
  reviewSeconds: nullable(amount),
  item: optional(objectOf(ITEM_LABEL)),
};

/** A `RunRow`, or a `LedgerSchemaError` naming the first bad field. */
export function validateRunRow(value: unknown): RunRow {
  objectOf(RUN_ROW)(value, "");
  const row = value as RunRow;
  // Time-to-done is censored unless the agent itself finished (Rule 4, wave-0 decision 6).
  if (row.time.toDoneMs !== null && row.outcome.endedHow !== EndedHow.AgentFinished)
    fail("time.toDoneMs", "null unless the run ended agent-finished");
  return row;
}

/** A `PairwiseRow`, or a `LedgerSchemaError` naming the first bad field. */
export function validatePairwiseRow(value: unknown): PairwiseRow {
  objectOf(PAIRWISE_ROW)(value, "");
  return value as PairwiseRow;
}

/** A `HumanRow`, or a `LedgerSchemaError` naming the first bad field. */
export function validateHumanRow(value: unknown): HumanRow {
  objectOf(HUMAN_ROW)(value, "");
  const row = value as HumanRow;
  // A pair review picks and says whether each side met the request; a grader-validation label does neither and names one run.
  const label = row.item !== undefined;
  if (label !== (row.pick === null)) fail("pick", "null exactly on a grader-validation label");
  if (label !== (row.requestSatisfied === null)) fail("requestSatisfied", "null exactly on a grader-validation label");
  if (label && row.runIds.a !== row.runIds.b) fail("runIds", "one run on both sides of a grader-validation label");
  return row;
}

/** Each row schema id and its validator. */
export const ROW_VALIDATORS: Readonly<Record<LedgerRow["schema"], (value: unknown) => LedgerRow>> = {
  [RUN_ROW_SCHEMA]: validateRunRow,
  [PAIRWISE_ROW_SCHEMA]: validatePairwiseRow,
  [HUMAN_ROW_SCHEMA]: validateHumanRow,
};

/** Any ledger row, dispatched on its `schema` id. */
export function validateLedgerRow(value: unknown): LedgerRow {
  if (!isPlainObject(value)) fail("row", "an object");
  const schema = value.schema;
  if (typeof schema !== "string" || !Object.hasOwn(ROW_VALIDATORS, schema)) fail("schema", "a known row schema");
  return ROW_VALIDATORS[schema as LedgerRow["schema"]](value);
}
