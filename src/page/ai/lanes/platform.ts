/**
 * The platform lane: a published game's calls go to genex.games through `@genex-ai/embed-sdk`,
 * paid from the player's Genex credits or answered by their own plan through the watcher. A
 * grant is genex.games' standing budget (`getActiveSpendGrant`, `requestSpendGrant`): the player
 * approves it once on Genex's own sheet, which inside Genex Desktop the SDK asks the app to draw
 * (`window.__genexDesktop.confirm`, embed-sdk 0.34) instead of opening a popup. `ask` and `act`
 * are `generate` with JSON output, `say` is `generateStream`, `judge` is genex.games' judge.
 *
 * The SDK's answers are read like any other input. An answer a player's own plan wrote
 * (`source: external`) is unverified, so it never decides a shared answer; genex.games' error
 * codes become the game's failure codes; and nothing here throws into the game.
 */
import {
  type AiBudgetView,
  AiDoor,
  AiErrorCode,
  type AiGrantRequest,
  AiGrantStatus,
  AiOp,
  AiProvenance,
  AiSource,
  AiTier,
  isPlainRecord,
  MICROS_PER_CREDIT,
} from "../../../shared/game-ai.ts";
import type { AiGrantAnswer } from "../../../shared/game-ai-bridge.ts";
import { AiLane } from "../../../shared/game-ai-lane.ts";
import { platformPrompt } from "../compile-prompts.ts";
import { AiGrantPeriod, type PlatformOptions } from "../types.ts";
import { PlatformJudgeType } from "../compile.ts";
import { answeredReply, type Lane, type LaneCall, type LaneReply, noGrant, refusedReply } from "./lane.ts";

/** A call's ceiling in credits when neither the call nor the game names one. */
export const PLATFORM_DEFAULT_MAX_CREDITS = 2;
/** The calls per period a game that names none is taken to make. */
export const PLATFORM_DEFAULT_CALLS = 20;
/** The credits one call is guessed to cost, for the grant sheet's estimate. */
const PLATFORM_ESTIMATE_CREDITS = 1;
/** genex.games' own model kind for its judge, which `generate` never calls. */
const JUDGE_MODEL_KIND = "typesafe";

/** genex.games' outcomes and the failure codes they become. Its own wire words: never rename one. */
export const PLATFORM_ERROR_CODES: Readonly<Record<string, AiErrorCode>> = {
  insufficient_credits: AiErrorCode.OutOfCredits,
  grant_insufficient_funds: AiErrorCode.OutOfCredits,
  insufficient_balance: AiErrorCode.OutOfCredits,
  credits_unverified: AiErrorCode.OutOfCredits,
  grant_limit_reached: AiErrorCode.ConsentRequired,
  grant_stopped: AiErrorCode.ConsentRequired,
  grant_expired: AiErrorCode.ConsentRequired,
  grant_not_active: AiErrorCode.ConsentRequired,
  grant_not_found: AiErrorCode.ConsentRequired,
  judge_requires_grant: AiErrorCode.ConsentRequired,
  judge_not_enabled: AiErrorCode.ConsentRequired,
  stream_requires_grant: AiErrorCode.ConsentRequired,
  grant_concurrency: AiErrorCode.Concurrency,
  generation_limit: AiErrorCode.Concurrency,
  external_request_active: AiErrorCode.Concurrency,
  judge_busy: AiErrorCode.Concurrency,
  grant_rate_limited: AiErrorCode.RateLimited,
  judge_period_limit: AiErrorCode.RateLimited,
  waiting_for_plan: AiErrorCode.WaitingForPlan,
  no_player_session: AiErrorCode.NoFunding,
  unauthorized: AiErrorCode.NoFunding,
  guest_no_wallet: AiErrorCode.NoFunding,
  player_wallet_required: AiErrorCode.NoFunding,
  session_revoked: AiErrorCode.NoFunding,
  judge_requires_credits: AiErrorCode.NoFunding,
  judge_requires_coins: AiErrorCode.NoFunding,
  external_not_allowed: AiErrorCode.NoFunding,
  generation_paused: AiErrorCode.DoorUnavailable,
  judge_paused: AiErrorCode.DoorUnavailable,
  external_unavailable: AiErrorCode.DoorUnavailable,
  player_update_required: AiErrorCode.DoorUnavailable,
  popup_blocked: AiErrorCode.DoorUnavailable,
  desktop_unsupported: AiErrorCode.DoorUnavailable,
  native_unsupported: AiErrorCode.DoorUnavailable,
  local_test_unsupported: AiErrorCode.DoorUnavailable,
  staging_no_generation: AiErrorCode.DoorUnavailable,
  untrusted_parent: AiErrorCode.DoorUnavailable,
  model_not_available: AiErrorCode.DoorUnavailable,
  runtime_models_unavailable: AiErrorCode.DoorUnavailable,
  generation_unavailable: AiErrorCode.DoorUnavailable,
  judge_unavailable: AiErrorCode.DoorUnavailable,
  grant_unavailable: AiErrorCode.DoorUnavailable,
  prompt_too_large: AiErrorCode.TooLarge,
  request_too_large: AiErrorCode.TooLarge,
  schema_too_large: AiErrorCode.TooLarge,
  output_tokens_too_large: AiErrorCode.TooLarge,
  invalid_schema: AiErrorCode.InvalidSchema,
  invalid_output: AiErrorCode.InvalidOutput,
  rejected: AiErrorCode.InvalidOutput,
  validation_failed: AiErrorCode.InvalidOutput,
  invalid_provider_response: AiErrorCode.InvalidOutput,
  canceled: AiErrorCode.Canceled,
  player_stopped: AiErrorCode.Canceled,
  game_stopped: AiErrorCode.Canceled,
  stream_aborted: AiErrorCode.Canceled,
  wait_timeout: AiErrorCode.Timeout,
  unknown: AiErrorCode.Timeout,
  invalid_request: AiErrorCode.BadRequest,
  invalid_max_output_tokens: AiErrorCode.BadRequest,
  invalid_grant_id: AiErrorCode.BadRequest,
  invalid_models: AiErrorCode.BadRequest,
  invalid_disclosure: AiErrorCode.BadRequest,
  invalid_declared_price: AiErrorCode.BadRequest,
  invalid_judge_terms: AiErrorCode.BadRequest,
  invalid_grant_terms: AiErrorCode.BadRequest,
  model_not_allowed: AiErrorCode.BadRequest,
};

/** genex.games' outcome words this lane reads. Its own wire words: never rename one. */
const Outcome = {
  Succeeded: "succeeded",
  Active: "active",
  Canceled: "canceled",
  Pending: "pending",
  Expired: "expired",
  External: "external",
} as const;

/** How `generate` is asked to answer. genex.games' own words: never rename one. */
const OutputFormat = { Text: "text", Json: "json" } as const;

/** genex.games' funding words for a grant the player's own plan answers. */
const PLAN_FUNDING: ReadonlySet<unknown> = new Set(["claude", "chatgpt"]);

/** genex.games' grant statuses, as the game's grant status. */
const GRANT_STATUS: Readonly<Record<string, AiGrantStatus>> = {
  active: AiGrantStatus.Active,
  suspended_insufficient_funds: AiGrantStatus.Paused,
  waiting_for_plan: AiGrantStatus.WaitingForPlan,
};

/** The failure code of a genex.games outcome word; one this lane does not know is a provider failure. */
export function platformCode(error: unknown): AiErrorCode {
  return typeof error === "string" && Object.hasOwn(PLATFORM_ERROR_CODES, error)
    ? (PLATFORM_ERROR_CODES[error] ?? AiErrorCode.Provider)
    : AiErrorCode.Provider;
}

/** The SDK functions this lane calls, found on the module the page loaded. */
export interface EmbedSdk {
  getActiveSpendGrant(): Promise<unknown>;
  requestSpendGrant(options: Record<string, unknown>): Promise<unknown>;
  stopSpendGrant(grantId: string): Promise<unknown>;
  generate(options: Record<string, unknown>): Promise<unknown>;
  generateStream(options: Record<string, unknown>): Promise<unknown>;
  judge(options: Record<string, unknown>): Promise<unknown>;
  getGenerationModels(): Promise<unknown>;
}

const SDK_FUNCTIONS = [
  "getActiveSpendGrant",
  "requestSpendGrant",
  "stopSpendGrant",
  "generate",
  "generateStream",
  "judge",
  "getGenerationModels",
] as const satisfies readonly (keyof EmbedSdk)[];

/** The SDK's functions on `module`, or null when it is not the embed SDK this lane needs. */
export function embedSdkOf(module: unknown): EmbedSdk | null {
  if (typeof module !== "object" || module === null) return null;
  const found: Partial<Record<keyof EmbedSdk, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const name of SDK_FUNCTIONS) {
    const fn: unknown = Reflect.get(module, name);
    if (typeof fn !== "function") return null;
    found[name] = async (...args: unknown[]) => Reflect.apply(fn, module, args);
  }
  return {
    getActiveSpendGrant: () => call(found.getActiveSpendGrant),
    requestSpendGrant: (options) => call(found.requestSpendGrant, options),
    stopSpendGrant: (grantId) => call(found.stopSpendGrant, grantId),
    generate: (options) => call(found.generate, options),
    generateStream: (options) => call(found.generateStream, options),
    judge: (options) => call(found.judge, options),
    getGenerationModels: () => call(found.getGenerationModels),
  };
}

const call = (fn: ((...args: unknown[]) => Promise<unknown>) | undefined, ...args: unknown[]): Promise<unknown> =>
  fn ? fn(...args) : Promise.reject(new Error(AiErrorCode.DoorUnavailable));

/** The code an SDK rejection carries (`error.message`), as a failure code. */
const codeOfError = (error: unknown): AiErrorCode => platformCode(error instanceof Error ? error.message : undefined);

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A grant's or a generation's id on genex.games (embed-protocol `isGenerationId`). */
const PLATFORM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** genex.games' grant view as the game's: no price list, no account, spend in micros. */
export function budgetOfGrant(raw: unknown): AiBudgetView | null {
  if (!isPlainRecord(raw) || typeof raw.id !== "string" || typeof raw.status !== "string") return null;
  if (!PLATFORM_ID_RE.test(raw.id)) return null;
  const status = Object.hasOwn(GRANT_STATUS, raw.status) ? GRANT_STATUS[raw.status] : undefined;
  if (!status) return null;
  const external = PLAN_FUNDING.has(raw.funding);
  const spent = Math.max(0, num(raw.spentCredits) ?? 0);
  const resumeAt = typeof raw.resumeAt === "string" ? raw.resumeAt.slice(0, 40) : null;
  return {
    id: raw.id,
    status,
    door: external ? AiDoor.PlanWatcher : AiDoor.GenexCredits,
    spentMicros: Math.round(spent * MICROS_PER_CREDIT),
    planUsedPercent: null,
    planResetsAt: status === AiGrantStatus.WaitingForPlan ? resumeAt : null,
  };
}

/** A model of genex.games' catalog: its id, its price, and whether it is featured. */
interface CatalogModel {
  id: string;
  price: number;
  featured: boolean;
}

/** The catalog's models `generate` can call, read. */
function catalogOf(raw: unknown): CatalogModel[] {
  const models = isPlainRecord(raw) && Array.isArray(raw.models) ? raw.models : [];
  return models.flatMap((model: unknown) => {
    if (!isPlainRecord(model) || typeof model.id !== "string" || model.kind === JUDGE_MODEL_KIND) return [];
    const price = (num(model.inputUsdPerMillion) ?? 0) + (num(model.outputUsdPerMillion) ?? 0);
    return [{ id: model.id, price, featured: model.featured === true }];
  });
}

/** The model a tier calls when the game names none: the cheapest featured model for fast, the dearest for smart. */
function pickModel(models: readonly CatalogModel[], tier: AiTier): string | null {
  const featured = models.filter((model) => model.featured);
  const pool = [...(featured.length ? featured : models)].sort((a, b) => a.price - b.price);
  const picked = tier === AiTier.Smart ? pool.at(-1) : pool[0];
  return picked?.id ?? null;
}

/** What the platform lane needs: the SDK, the game's terms, and how to number idempotency keys. */
export interface PlatformLaneOptions {
  sdk: EmbedSdk;
  terms: PlatformOptions;
  /** A per-page prefix that makes every call's idempotency key its own. */
  session: string;
}

/** A grant answer from what `requestSpendGrant` resolved. */
function grantResult(raw: unknown): AiGrantAnswer {
  if (!isPlainRecord(raw)) return noGrant(AiErrorCode.DoorUnavailable);
  if (raw.status === Outcome.Active) {
    const view = budgetOfGrant(raw.grant);
    return view ? { view, code: null } : noGrant(AiErrorCode.DoorUnavailable);
  }
  if (raw.status === Outcome.Canceled) return noGrant(AiErrorCode.ConsentDeclined);
  if (raw.status === Outcome.Pending) return noGrant(AiErrorCode.ConsentPending);
  if (raw.status === Outcome.Expired) return noGrant(AiErrorCode.ConsentRequired);
  return noGrant(platformCode(raw.error));
}

/** A generation's outcome as a lane reply: an answer with where it came from, or why there is none. */
function generationReply(ticket: string, raw: unknown): LaneReply {
  if (!isPlainRecord(raw)) return refusedReply(ticket, AiErrorCode.Provider, null);
  if (raw.status !== Outcome.Succeeded) {
    if (raw.status === Outcome.Pending) return refusedReply(ticket, AiErrorCode.Timeout, null);
    if (raw.status === Outcome.Canceled) return refusedReply(ticket, AiErrorCode.Canceled, null);
    return refusedReply(ticket, platformCode(raw.error), null);
  }
  const external = raw.source === Outcome.External;
  const origin = external
    ? { source: AiSource.External, provenance: AiProvenance.Unverified }
    : { source: AiSource.GenexCredits, provenance: AiProvenance.Verified };
  return answeredReply(ticket, raw.output, origin, null);
}

/** One judge answer as the game reads it: a probability, an option's name, or a level from 0. */
function judgeValue(kind: string, answer: unknown, levels: readonly string[]): unknown {
  if (!isPlainRecord(answer)) return undefined;
  if (kind === PlatformJudgeType.YesNo) return num(answer.noul) ?? undefined;
  if (kind === PlatformJudgeType.Choice) return typeof answer.choice === "string" ? answer.choice : undefined;
  return scoreLevel(answer, levels);
}

/** A score answer's level: the likeliest level when genex.games gives them by name, else its score rounded. */
function scoreLevel(answer: Record<string, unknown>, levels: readonly string[]): number | undefined {
  const odds = isPlainRecord(answer.probabilities) ? answer.probabilities : {};
  const named = levels.map((level, index) => ({ index, p: num(odds[level]) ?? -1 }));
  const likeliest = named.reduce((best, next) => (next.p > best.p ? next : best), { index: -1, p: -1 });
  if (likeliest.index >= 0) return likeliest.index;
  const score = num(answer.score);
  return score === null ? undefined : Math.min(levels.length - 1, Math.max(0, Math.round(score)));
}

/** A judge's outcome as a lane reply, its answers as the game's judge value. */
function judgeReply(lane: LaneCall, raw: unknown): LaneReply {
  const ticket = lane.call.wire.ticket;
  const questions = lane.call.judge?.questions ?? {};
  if (!isPlainRecord(raw) || raw.status !== Outcome.Succeeded) return generationReply(ticket, raw);
  const answers = isPlainRecord(raw.answers) ? raw.answers : {};
  const value: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    const levels = question.type === PlatformJudgeType.Score ? question.criteria : [];
    value[name] = judgeValue(question.type, answers[name], levels);
  }
  return answeredReply(ticket, value, { source: AiSource.GenexCredits, provenance: AiProvenance.Verified }, null);
}

/** One platform lane's state: the SDK, the game's terms, its keys and genex.games' catalog. */
interface Platform {
  sdk: EmbedSdk;
  terms: PlatformOptions;
  maxCredits: number;
  /** A fresh idempotency key: the page's session and a count. */
  key(): string;
  /** genex.games' catalog, read once. */
  models(): Promise<CatalogModel[]>;
}

/** The model a tier calls: the game's, else genex.games' pick. */
async function modelFor(platform: Platform, tier: AiTier): Promise<string | null> {
  const named = platform.terms.models?.[tier];
  if (typeof named === "string" && named) return named;
  return pickModel(await platform.models(), tier);
}

/** An `ask`, `act` or `say` on genex.games under the game's grant. */
async function generation(platform: Platform, lane: LaneCall): Promise<LaneReply> {
  const { wire } = lane.call;
  const modelId = await modelFor(platform, wire.tier);
  if (!modelId) return refusedReply(wire.ticket, AiErrorCode.DoorUnavailable, null);
  const prompt = platformPrompt({
    system: wire.system,
    memory: wire.memory,
    prompt: wire.prompt,
    untrusted: Object.entries(wire.untrusted),
  });
  const base = {
    grantId: lane.grantId,
    modelId,
    prompt,
    maxCredits: lane.call.maxCredits ?? platform.maxCredits,
    maxOutputTokens: wire.maxOutputTokens,
    idempotencyKey: platform.key(),
  };
  if (wire.op === AiOp.Say) {
    const onDelta = (_text: unknown, soFar: unknown) => typeof soFar === "string" && lane.onDelta(soFar);
    const raw = await platform.sdk.generateStream({
      ...base,
      outputFormat: OutputFormat.Text,
      onDelta,
      signal: lane.signal,
    });
    return generationReply(wire.ticket, raw);
  }
  const raw = await platform.sdk.generate({ ...base, outputFormat: OutputFormat.Json, schema: wire.schema });
  return generationReply(wire.ticket, raw);
}

/** A `judge` on genex.games' own judge, with the game's questions in its shapes. */
async function judge(platform: Platform, lane: LaneCall): Promise<LaneReply> {
  const { wire, judge: asked } = lane.call;
  if (!asked) return refusedReply(wire.ticket, AiErrorCode.BadRequest, null);
  const raw = await platform.sdk.judge({
    grantId: lane.grantId,
    state: asked.state,
    questions: asked.questions,
    idempotencyKey: platform.key(),
  });
  return judgeReply(lane, raw);
}

/** Ask genex.games for a grant: the player's sheet shows these terms and bounds every call by them. */
async function requestGrant(platform: Platform, request: AiGrantRequest): Promise<AiGrantAnswer> {
  const { terms, maxCredits } = platform;
  const picked = await Promise.all(request.tiers.map((tier) => modelFor(platform, tier)));
  const models = [...new Set(picked.filter((id) => id !== null))];
  const calls = terms.callsPerPeriod ?? PLATFORM_DEFAULT_CALLS;
  const estimate = Math.min(PLATFORM_ESTIMATE_CREDITS, maxCredits);
  const judgeCalls = terms.judgeCallsPerPeriod;
  const raw = await platform.sdk.requestSpendGrant({
    models,
    perCallMaxCredits: maxCredits,
    perCallEstimateCredits: estimate,
    disclosure: {
      periodLabel: terms.period ?? AiGrantPeriod.Session,
      estimatedCallsPerPeriod: calls,
      estimatedCreditsPerPeriod: calls * estimate,
    },
    ...(judgeCalls ? { judge: { enabled: true, estimatedCallsPerPeriod: judgeCalls } } : {}),
    allowExternal: terms.allowPlan ?? true,
    idempotencyKey: platform.key(),
  });
  return grantResult(raw);
}

/** The grant the player already approved for this game, or none. */
async function activeGrant(platform: Platform): Promise<AiGrantAnswer> {
  try {
    const raw = await platform.sdk.getActiveSpendGrant();
    if (raw === null) return noGrant(null);
    const view = budgetOfGrant(raw);
    return view ? { view, code: null } : noGrant(null);
  } catch (error) {
    return noGrant(codeOfError(error));
  }
}

/** A call that throws is the failure its error names. */
async function guarded(
  platform: Platform,
  lane: LaneCall,
  run: (platform: Platform, lane: LaneCall) => Promise<LaneReply>,
): Promise<LaneReply> {
  try {
    return await run(platform, lane);
  } catch (error) {
    return refusedReply(lane.call.wire.ticket, codeOfError(error), null);
  }
}

/** The platform's state for one lane. */
function platformOf(options: PlatformLaneOptions): Platform {
  let keys = 0;
  let catalog: Promise<CatalogModel[]> | null = null;
  return {
    sdk: options.sdk,
    terms: options.terms,
    maxCredits: options.terms.maxCredits ?? PLATFORM_DEFAULT_MAX_CREDITS,
    key() {
      keys += 1;
      return `${options.session}-${keys}`;
    },
    models() {
      catalog ??= options.sdk.getGenerationModels().then(catalogOf, () => []);
      return catalog;
    },
  };
}

/** The platform lane over the embed SDK. */
export function platformLane(options: PlatformLaneOptions): Lane {
  const platform = platformOf(options);
  return {
    lane: AiLane.Platform,
    needsGrant: true,
    async open() {
      // The catalog is read now, so a grant asked inside a gesture does not wait on it.
      const named = Object.values(AiTier).every((tier) => typeof options.terms.models?.[tier] === "string");
      if (!named) void platform.models();
      return { on: true, grant: await activeGrant(platform), tape: null };
    },
    call: (lane) => guarded(platform, lane, lane.call.wire.op === AiOp.Judge ? judge : generation),
    cancel: () => {},
    activeGrant: () => activeGrant(platform),
    async requestGrant(request) {
      try {
        return await requestGrant(platform, request);
      } catch (error) {
        return noGrant(codeOfError(error));
      }
    },
    async stopGrant(grantId) {
      if (!grantId) return false;
      try {
        await platform.sdk.stopSpendGrant(grantId);
        return true;
      } catch {
        return false;
      }
    },
    reseed: () => {},
  };
}
