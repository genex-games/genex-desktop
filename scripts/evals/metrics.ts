/**
 * The metric catalog (§7): pure functions from one `RunObservation` to the metric blocks of a
 * `RunRow` (`time`, `tokens`, `context`, `calls`, `cost`, `model.served`) and the two guards the
 * observation alone can trip (`token-mismatch`, `served-model-mismatch`). A missing value is null
 * with a `Coverage` reason, or `unavailable(reason)`, never zero (Rule 2).
 *
 * - Time to done is censored (null) unless the run ended `agent-finished` (Rule 4); a dirty trace
 *   marks timing `trace-dirty` (Rule 3).
 * - Tokens are the model calls' normalized usage (Rule 13), split by role and by model; Genex
 *   lanes are `partial-judges` until a judge call with measured tokens reaches the timeline (M4.5).
 * - `verifiedBeforeDone` is `!(edits ≥ 10 && builds = 0)`, and null unless the agent finished on
 *   a clean trace.
 * - `apiEquivalentUsd` prices every model's tokens with `evals/prices.json` (Rule 15); one model
 *   without a price makes the whole figure `unavailable: price-unknown`.
 */
import { TokenRole, type TokenUsage } from "../../src/shared/eval-lane.ts";
import { untaggedModelId } from "../../src/shared/model-id.ts";
import type { ProviderUsage } from "../../src/shared/provider-usage.ts";
import { CollectError, CollectErrorCode, isTraceClean } from "./collect/honesty.ts";
import type {
  BuildSpanEvent,
  ModelCallEvent,
  ObservationEvent,
  RunObservation,
  ToolCallEvent,
} from "./collect/observation.ts";
import { AUXILIARY_CALL_PREFIX } from "./collect/observe.ts";
import { sumUsage, totalTokens } from "./collect/usage.ts";
import {
  unavailable,
  type BuildSpan,
  type Pinned,
  type QuotaDelta,
  type RowCalls,
  type RowContext,
  type RowCost,
  type RowTime,
  type RowTokens,
  type ServedModel,
} from "./ledger/types.ts";
import { apiEquivalentUsd, type PriceTable } from "./prices.ts";
import {
  BuildSpanKind,
  Coverage,
  EndedHow,
  EvalAgent,
  HarnessFailure,
  ObservationEventKind,
  ObservationSource,
  ObservedErrorKind,
  PreviewSignal,
  ServedModelRole,
  ToolCategory,
  UnavailableReason,
} from "./vocabulary.ts";

export { classifyCommand, classifyTool, unwrapShell } from "../../src/shared/tool-category.ts";

/** Stream and transcript totals may differ by this fraction of the stream's before `token-mismatch` (Rule 13). */
export const TOKEN_CROSS_CHECK_TOLERANCE = 0.02;
/** Edits at or above this count with no build or test call mean the agent never verified its work. */
export const UNVERIFIED_EDIT_THRESHOLD = 10;
const PERCENT = 100;
/** A dated model id (`claude-haiku-4-5-20251001`) prices as its undated family id. */
const DATE_SUFFIX = /-\d{8}$/;

/** Every served role's token role. */
const TOKEN_ROLE: Readonly<Record<ServedModelRole, TokenRole>> = {
  [ServedModelRole.Main]: TokenRole.Lead,
  [ServedModelRole.Worker]: TokenRole.Workers,
  [ServedModelRole.Judge]: TokenRole.Judges,
  [ServedModelRole.Subagent]: TokenRole.Subagents,
  [ServedModelRole.Auxiliary]: TokenRole.Auxiliary,
};

const ofKind =
  <K extends ObservationEvent["kind"]>(kind: K) =>
  (obs: RunObservation): Extract<ObservationEvent, { kind: K }>[] =>
    obs.timeline.filter((event): event is Extract<ObservationEvent, { kind: K }> => event.kind === kind);
const modelCallsOf = ofKind(ObservationEventKind.ModelCall);
const toolCallsOf = ofKind(ObservationEventKind.ToolCall);
const buildSpansOf = ofKind(ObservationEventKind.BuildSpan);

const isClean = (obs: RunObservation) => isTraceClean(obs.provenance.traceComplete);
const isAggregate = (call: ModelCallEvent) => call.id.startsWith(AUXILIARY_CALL_PREFIX);
const fromTranscripts = (calls: readonly ModelCallEvent[]) =>
  calls.some((call) => call.source === ObservationSource.Transcript);

/** The median of a non-empty list, rounded to a whole millisecond; null for none. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const middle = sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(middle);
}

/** Whether time to done is censored: every ending but `agent-finished` is our rail, not the model's decision (Rule 4). */
export const isToDoneCensored = (obs: RunObservation): boolean => obs.endedHow !== EndedHow.AgentFinished;

function spanOf(event: BuildSpanEvent): BuildSpan[] {
  return event.endMs === null ? [] : [{ kind: event.span, ms: Math.max(0, event.endMs - event.atMs) }];
}

/** The app's own first `preview_ready` when it recorded one (M4.4), else the earliest proxy signal, else the lane report's. */
function firstPreviewMs(obs: RunObservation): number | null {
  const signals = ofKind(ObservationEventKind.PreviewSignal)(obs);
  const ready = signals.filter((event) => event.signal === PreviewSignal.PreviewReady);
  const chosen = (ready.length ? ready : signals).map((event) => event.atMs);
  if (chosen.length) return Math.min(...chosen);
  return obs.provenance.laneReport?.firstPreviewProxyMs ?? null;
}

function timeCoverage(obs: RunObservation): Coverage {
  if (obs.wallMs === null) return Coverage.Unmeasured;
  return isClean(obs) ? Coverage.Full : Coverage.TraceDirty;
}

/** `time.*` (§7): wall time, censored time to done, first preview, build spans. Boot and playable times are the grader's. */
export function timeMetrics(obs: RunObservation): RowTime {
  const builds = buildSpansOf(obs).flatMap(spanOf);
  const delegations = builds.filter((build) => build.kind === BuildSpanKind.ChatDelegation).map((build) => build.ms);
  return {
    wallMs: obs.wallMs,
    toDoneMs: isToDoneCensored(obs) ? null : obs.wallMs,
    firstBootMs: null,
    firstPlayableMs: null,
    firstPlayableResolutionMs: null,
    firstPreviewMs: firstPreviewMs(obs),
    delegationP50Ms: median(delegations),
    builds,
    coverage: timeCoverage(obs),
  };
}

/** Whether some judge call carries measured tokens (the Genex event log's `completion_call` usage, M4.5). */
const judgesMeasured = (calls: readonly ModelCallEvent[]): boolean =>
  calls.some((call) => call.session.role === ServedModelRole.Judge && totalTokens(call.usage) > 0);

function tokenCoverage(obs: RunObservation, calls: readonly ModelCallEvent[]): Coverage {
  if (!calls.length) return Coverage.Unmeasured;
  if (!isClean(obs)) return Coverage.TraceDirty;
  if (obs.agent === EvalAgent.GenexApp) return judgesMeasured(calls) ? Coverage.Full : Coverage.PartialJudges;
  return fromTranscripts(calls) ? Coverage.Full : Coverage.StreamOnly;
}

function usageBy(calls: readonly ModelCallEvent[], keyOf: (call: ModelCallEvent) => string): Map<string, TokenUsage> {
  const groups = new Map<string, TokenUsage[]>();
  for (const call of calls) groups.set(keyOf(call), [...(groups.get(keyOf(call)) ?? []), call.usage]);
  return new Map([...groups].map(([key, usages]) => [key, sumUsage(usages)]));
}

function byRoleOf(calls: readonly ModelCallEvent[]): Partial<Record<TokenRole, TokenUsage>> {
  const sums = usageBy(calls, (call) => TOKEN_ROLE[call.session.role]);
  const out: Partial<Record<TokenRole, TokenUsage>> = {};
  for (const role of Object.values(TokenRole)) {
    const usage = sums.get(role);
    if (usage) out[role] = usage;
  }
  return out;
}

/** `tokens.*` (Rule 13): the normalized totals, by role and by model, with their coverage. */
export function tokenMetrics(obs: RunObservation): RowTokens {
  const calls = modelCallsOf(obs);
  const total = sumUsage(calls.map((call) => call.usage));
  return {
    ...total,
    byRole: byRoleOf(calls),
    byModel: Object.fromEntries(usageBy(calls, (call) => untaggedModelId(call.model))),
    coverage: tokenCoverage(obs, calls),
  };
}

interface SessionPeak {
  role: ServedModelRole;
  pct: number | null;
  tokens: number | null;
}

function higher(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}

function readingsOf(
  obs: RunObservation,
): Array<{ key: string; role: ServedModelRole; pct: number | null; tokens: number | null }> {
  const out: Array<{ key: string; role: ServedModelRole; pct: number | null; tokens: number | null }> = [];
  for (const event of obs.timeline) {
    if (event.kind === ObservationEventKind.ModelCall && !isAggregate(event)) {
      const { contextTokens: tokens, contextWindow: window } = event;
      const pct = tokens !== null && window ? (tokens / window) * PERCENT : null;
      out.push({ key: `${event.session.role}:${event.session.sessionId}`, role: event.session.role, pct, tokens });
    }
    if (event.kind === ObservationEventKind.ContextSample) {
      const key = `${event.session.role}:${event.session.sessionId}`;
      out.push({ key, role: event.session.role, pct: event.percent, tokens: event.tokens });
    }
  }
  return out;
}

function sessionPeaks(obs: RunObservation): SessionPeak[] {
  const peaks = new Map<string, SessionPeak>();
  for (const reading of readingsOf(obs)) {
    const peak = peaks.get(reading.key) ?? { role: reading.role, pct: null, tokens: null };
    peak.pct = higher(peak.pct, reading.pct);
    peak.tokens = higher(peak.tokens, reading.tokens);
    peaks.set(reading.key, peak);
  }
  return [...peaks.values()];
}

const roundTenth = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

function peakOf(peaks: readonly SessionPeak[], role: ServedModelRole, field: "pct" | "tokens"): number | null {
  return peaks
    .filter((peak) => peak.role === role)
    .reduce<number | null>((max, peak) => higher(max, peak[field]), null);
}

/** `context.*` (§7): per session, the largest prompt over the context window; the lead's is the headline. */
export function contextMetrics(obs: RunObservation): RowContext {
  const peaks = sessionPeaks(obs);
  const leadPeakTokens = peakOf(peaks, ServedModelRole.Main, "tokens");
  const measured = leadPeakTokens !== null || peakOf(peaks, ServedModelRole.Main, "pct") !== null;
  const clean = isClean(obs) ? Coverage.Full : Coverage.TraceDirty;
  const coverage = measured ? clean : Coverage.Unmeasured;
  return {
    leadPeakPct: roundTenth(peakOf(peaks, ServedModelRole.Main, "pct")),
    leadPeakTokens,
    workersPeakPct: roundTenth(peakOf(peaks, ServedModelRole.Worker, "pct")),
    compactions: measured ? ofKind(ObservationEventKind.Compaction)(obs).length : null,
    coverage,
  };
}

/** The longest run of edits with no build, test or browser look between them (the ported `analyzeRun`). */
export function blindEditStreak(tools: readonly ToolCallEvent[]): number {
  let streak = 0;
  let best = 0;
  for (const tool of [...tools].sort((a, b) => a.atMs - b.atMs)) {
    if (tool.category === ToolCategory.Edit) {
      streak += 1;
      best = Math.max(best, streak);
    }
    if (tool.category === ToolCategory.Build || tool.category === ToolCategory.Browser) streak = 0;
  }
  return best;
}

/** `!(edits ≥ 10 && builds = 0)`, only when the agent finished on a clean trace (Rule 3); null otherwise. */
export function verifiedBeforeDone(obs: RunObservation, tools: readonly ToolCallEvent[]): boolean | null {
  if (obs.endedHow !== EndedHow.AgentFinished || !isClean(obs)) return null;
  const edits = tools.filter((tool) => tool.category === ToolCategory.Edit).length;
  const builds = tools.filter((tool) => tool.category === ToolCategory.Build).length;
  return !(edits >= UNVERIFIED_EDIT_THRESHOLD && builds === 0);
}

function streamed(obs: RunObservation): boolean {
  const streamTokens = obs.provenance.streamTokens;
  if (streamTokens && totalTokens(streamTokens) > 0) return true;
  return obs.timeline.some(
    (event) => event.source === ObservationSource.Stream && event.kind === ObservationEventKind.ToolCall,
  );
}

function callCoverage(obs: RunObservation, calls: readonly ModelCallEvent[]): Coverage {
  if (!calls.length) return Coverage.Unmeasured;
  if (!isClean(obs)) return Coverage.TraceDirty;
  return fromTranscripts(calls) ? Coverage.Full : Coverage.StreamOnly;
}

/**
 * `calls.*` (§7): distinct model responses, tool calls by category, the blind-edit streak,
 * sub-agent calls and `verifiedBeforeDone`. Throws `vacuous-model-calls` when the stream shows
 * work but no model call was measured (Rule 3).
 */
export function callMetrics(obs: RunObservation): RowCalls {
  const calls = modelCallsOf(obs).filter((call) => !isAggregate(call));
  if (!calls.length && streamed(obs)) throw new CollectError(CollectErrorCode.VacuousModelCalls, obs.runId);
  const tools = toolCallsOf(obs);
  const byCategory: Partial<Record<ToolCategory, number>> = {};
  for (const tool of tools) byCategory[tool.category] = (byCategory[tool.category] ?? 0) + 1;
  return {
    modelCalls: calls.length ? calls.length : null,
    tools: { total: tools.length, byCategory },
    blindEditStreak: tools.length ? blindEditStreak(tools) : null,
    subagents: byCategory[ToolCategory.Subagent] ?? 0,
    verifiedBeforeDone: verifiedBeforeDone(obs, tools),
    coverage: callCoverage(obs, calls),
  };
}

/** A served id without its context tag (`untaggedModelId`) and then its date suffix: the family id. */
export const bareModelId = (served: string): string => untaggedModelId(served).replace(DATE_SUFFIX, "");

/** The price table's id for a served model id: its family id, so a tagged or dated id still prices. */
export const priceModelId = bareModelId;

/** API-equivalent USD for every model's tokens (Rule 15); unavailable when any model has no price. */
export function apiEquivalentCost(obs: RunObservation, prices: PriceTable): Pinned<number> {
  const byModel = tokenMetrics(obs).byModel;
  const models = Object.keys(byModel);
  if (!models.length) return unavailable(UnavailableReason.NotRecorded);
  let usd = 0;
  for (const model of models) {
    const usage = byModel[model];
    const cost = usage ? apiEquivalentUsd(prices, priceModelId(model), usage) : null;
    if (cost === null) return unavailable(UnavailableReason.PriceUnknown);
    usd += cost;
  }
  return Math.round(usd * 10_000) / 10_000;
}

function resetInside(before: string | undefined, after: string | undefined, measuredAt: string): boolean {
  if (before !== after) return true;
  const resetsAt = before ? Date.parse(before) : Number.NaN;
  return Number.isFinite(resetsAt) && resetsAt <= Date.parse(measuredAt);
}

/** One delta per quota window, joined by window id; a reset inside the run is flagged, never subtracted. */
export function quotaDeltas(before: ProviderUsage | null, after: ProviderUsage | null): QuotaDelta[] {
  if (!before || !after) return [];
  return before.windows.map((window) => {
    const later = after.windows.find((candidate) => candidate.id === window.id);
    return {
      windowId: window.id,
      before: window.percent,
      after: later?.percent ?? null,
      resetsAtBefore: window.resetsAt ?? null,
      resetsAtAfter: later?.resetsAt ?? null,
      resetInside: resetInside(window.resetsAt, later?.resetsAt, after.measuredAt),
    };
  });
}

/** `cost.*` (Rule 15): API-equivalent for every lane, the CLI's own figure as a cross-check, nothing billed, quota deltas. */
export function costMetrics(obs: RunObservation, prices: PriceTable): RowCost {
  return {
    apiEquivalentUsd: apiEquivalentCost(obs, prices),
    priceTable: prices.asOf,
    cliReportedUsd: obs.provenance.cliReportedUsd,
    billed: null,
    quota: quotaDeltas(obs.provenance.quotaBefore, obs.provenance.quotaAfter),
  };
}

/**
 * `token-mismatch` when the transcripts' main session and the stream's own totals differ by more
 * than 2% of the stream's (Rule 13); null when they agree or either is missing.
 */
export function tokenCrossCheck(obs: RunObservation): HarnessFailure | null {
  const stream = obs.provenance.streamTokens;
  const main = modelCallsOf(obs).filter(
    (call) => call.source === ObservationSource.Transcript && call.session.role === ServedModelRole.Main,
  );
  if (!stream || !main.length) return null;
  const expected = totalTokens(stream);
  const measured = totalTokens(sumUsage(main.map((call) => call.usage)));
  const drift = Math.abs(measured - expected) / Math.max(expected, 1);
  return drift > TOKEN_CROSS_CHECK_TOLERANCE ? HarnessFailure.TokenMismatch : null;
}

/**
 * Whether a served id is the requested model, allowing one context tag and the provider's date
 * suffix. The one comparison every served-model guard uses (lane guards and Rule 16).
 */
export function isSameModel(requested: string, served: string): boolean {
  return served === requested || bareModelId(served) === requested;
}

/** `served-model-mismatch` when the main loop reported a model other than the one requested (Rule 16). */
export function servedModelCheck(obs: RunObservation): HarnessFailure | null {
  const served = obs.provenance.servedMain;
  if (served === null || isSameModel(obs.modelRequested, served)) return null;
  return HarnessFailure.ServedModelMismatch;
}

/**
 * An engine fallback during the run (`engine_fallback`, §5.5): the agent switched to another engine
 * than its lane's, so the row would credit the lane with another engine's work: contamination.
 */
export function engineFallbackCheck(obs: RunObservation): HarnessFailure | null {
  const fellBack = obs.timeline.some(
    (event) => event.kind === ObservationEventKind.Error && event.error === ObservedErrorKind.Fallback,
  );
  return fellBack ? HarnessFailure.Contamination : null;
}

/** The harness failure the observation alone shows: the token cross-check, the served model, then an engine fallback. */
export function observedHarnessFailure(obs: RunObservation): HarnessFailure | null {
  return tokenCrossCheck(obs) ?? servedModelCheck(obs) ?? engineFallbackCheck(obs);
}

/** `model.served[]`: every model by role, with its tokens; auxiliary and sub-agent models never fail a run. */
export function servedModels(obs: RunObservation): ServedModel[] {
  const groups = new Map<string, { id: string; role: ServedModelRole; usages: TokenUsage[] }>();
  for (const call of modelCallsOf(obs)) {
    const id = untaggedModelId(call.model);
    const key = `${call.session.role}/${id}`;
    const group = groups.get(key) ?? { id, role: call.session.role, usages: [] };
    group.usages.push(call.usage);
    groups.set(key, group);
  }
  const rank = (model: ServedModel) => (model.role === ServedModelRole.Main ? 0 : 1);
  return [...groups.values()]
    .map((group): ServedModel => ({ id: group.id, role: group.role, tokens: sumUsage(group.usages) }))
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id) || a.role.localeCompare(b.role));
}

/** The effort the main loop reported, or `unavailable: cli-unreported`. */
export function effortServed(obs: RunObservation): Pinned<string> {
  return obs.provenance.effortServed ?? unavailable(UnavailableReason.CliUnreported);
}

/** Every metric block of one run, and the first guard the observation trips. */
export interface RunMetrics {
  time: RowTime;
  tokens: RowTokens;
  context: RowContext;
  calls: RowCalls;
  cost: RowCost;
  served: ServedModel[];
  effortServed: Pinned<string>;
  harnessFailure: HarnessFailure | null;
}

/** All of §7 that the observation alone decides. */
export function runMetrics(obs: RunObservation, prices: PriceTable): RunMetrics {
  return {
    time: timeMetrics(obs),
    tokens: tokenMetrics(obs),
    context: contextMetrics(obs),
    calls: callMetrics(obs),
    cost: costMetrics(obs, prices),
    served: servedModels(obs),
    effortServed: effortServed(obs),
    harnessFailure: observedHarnessFailure(obs),
  };
}
