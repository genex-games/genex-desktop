/**
 * The plan watcher's genex.games client: the seven player routes a Genex player credential can
 * reach (genex-demo `apps/api/src/credential-class.ts: PLAYER_MCP_ROUTE_ALLOWLIST`), ported from
 * genex-demo `apps/cli/src/lib/player/api.ts`. It is written as that list rather than as a general
 * fetcher, so "what can this do to my account" reads off one file: nothing that moves money.
 *
 * Rules the loop depends on:
 *  - Every call carries `x-genex-player-version`: genex.games refuses a watcher below its floor
 *    with 426 and both version numbers, the only way it can tell an app to update.
 *  - Every answer is read as hostile input with the readers below, never cast. genex.games
 *    composes each job, but part of a job becomes a CLI's argv, and a body is read only up to
 *    {@link MAX_ANSWER_BYTES}.
 *  - Errors carry statuses and codes, never a prompt or an output.
 */
import { readCapped } from "../../plugins/genex/http.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import {
  AI_MAX_SCHEMA_BYTES,
  AI_MAX_WALK_DEPTH,
  AI_MAX_WALK_NODES,
  isBoundedJson,
  isPlainRecord,
  readMember,
} from "../../shared/game-ai.ts";

/** The header genex.games reads the watcher's version from. */
export const PLAYER_VERSION_HEADER = "x-genex-player-version";
/** The header naming which funding lane a queue call is for (`claude` when unset, server-side). */
export const EXTERNAL_PROVIDER_HEADER = "x-genex-external-provider";

/** One request, including reading its answer: a stuck socket must not park the loop. */
const REQUEST_TIMEOUT_MS = 30 * SECOND_MS;
/** The most of one answer that is read: fifty full jobs and their envelope. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
/** The most pending rows one poll hands the loop; it works one and lists again. */
const MAX_PENDING_ROWS = 50;
/** The longest system text a job may carry, in characters. */
const MAX_SYSTEM_CHARS = 32 * 1024;
/** The longest user text a job may carry, in characters (genex.games bounds it at 16 KB of game text plus framing). */
const MAX_USER_CHARS = 64 * 1024;
/** The longest game name a row may carry. */
const MAX_GAME_NAME_CHARS = 200;
/** The most output tokens a job may ask for. */
const MAX_OUTPUT_TOKENS = 1_000_000;
/** The longest lease genex.games may name, in seconds. */
const MAX_LEASE_SECONDS = 3600;
/** The most args a served policy may give one CLI, and the longest one. */
const MAX_POLICY_ARGS = 32;
const MAX_POLICY_ARG_CHARS = 200;
/** The slowest poll a policy may ask for, in seconds. */
const MAX_POLL_SECONDS = 3600;
/** The cadence a heartbeat answer without one gets, in seconds. */
const DEFAULT_POLL_SECONDS = 5;
/** The longest wait a release may name: the route's own bound, in seconds. */
const MAX_RETRY_SECONDS = 86_400;
/** A schema's own walk bounds: the message bounds, at most a schema's bytes. */
const SCHEMA_BOUNDS = { nodes: AI_MAX_WALK_NODES, depth: AI_MAX_WALK_DEPTH, chars: AI_MAX_SCHEMA_BYTES } as const;

/** A row's or a watcher's id: never a path, a query or a space. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** A CLI model name: a word that can never read as a flag. */
const CLI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/;
/** A served flag naming the model: a long option. */
const MODEL_FLAG_RE = /^--[a-z][a-z0-9-]{0,40}$/;
/** A version or status token as genex.games spells them. */
const TOKEN_RE = /^[A-Za-z0-9._+-]{1,64}$/;
/** A control character anywhere in a served arg. */
const CONTROL_RE = /\p{Cc}/u;

/** The funding lanes the queue is read by. Wire values: never rename one. */
export const PlayerProvider = {
  /** Games funded by the person's Claude plan, answered with Claude Code. */
  Claude: "claude",
  /** Games funded by the person's ChatGPT plan, answered with Codex. */
  ChatGpt: "chatgpt",
} as const;
export type PlayerProvider = (typeof PlayerProvider)[keyof typeof PlayerProvider];

/** Why a row is handed back unfinished: the four words the release route accepts. Wire values: never rename one. */
export const PlayerRelease = {
  /** The plan said wait: genex.games parks the grant behind the row until the time given. */
  RateLimited: "rate_limited",
  /** This Mac could not run the CLI (missing, signed out of the box, shutting down). */
  RunnerUnavailable: "runner_unavailable",
  Failed: "failed",
  /** The CLI is signed out: the person has to sign it in again. */
  AuthExpired: "auth_expired",
} as const;
export type PlayerRelease = (typeof PlayerRelease)[keyof typeof PlayerRelease];

/** A job's answer shape. Wire values: never rename one. */
export const RunnerOutputFormat = { Text: "text", Json: "json" } as const;
export type RunnerOutputFormat = (typeof RunnerOutputFormat)[keyof typeof RunnerOutputFormat];

/** Whether a job is a one-time request or a long-usage grant's. Wire values: never rename one. */
export const RunnerMode = { OneTime: "one_time", LongUsage: "long_usage" } as const;
export type RunnerMode = (typeof RunnerMode)[keyof typeof RunnerMode];

/** The model a job names: its family decides the CLI. */
export interface RunnerModel {
  id: string;
  family: PlayerProvider;
  cliModel: string;
}

/** One job, composed by genex.games: the watcher improvises nothing. */
export interface RunnerJob {
  system: string;
  user: string;
  outputFormat: RunnerOutputFormat;
  /** A JSON Schema the answer must match, on a JSON job. */
  schema?: unknown;
  model: RunnerModel;
  maxOutputTokens: number;
  mode: RunnerMode;
  grantId: string | null;
  leaseSeconds: number;
}

/** How one CLI is invoked, as genex.games serves it. */
export interface RunnerBinaryPolicy {
  args?: string[];
  modelFlag?: string;
}

/** The served runner policy, as much of it as the watcher reads. */
export interface PlayerPolicy {
  version: string;
  minVersion: string;
  latestVersion: string;
  pollIntervalSeconds: number;
  backoff: { initialSeconds: number; maxSeconds: number; factor: number; jitterRatio: number };
  claude?: RunnerBinaryPolicy;
  codex?: RunnerBinaryPolicy;
}

/**
 * What the loop uses when the policy route cannot be read: genex-demo's committed default
 * (`apps/api/src/runtime-generation/player-policy.ts`), so an unreadable policy degrades to the
 * shipped behaviour, not to none.
 */
export const FALLBACK_POLICY: PlayerPolicy = {
  version: "fallback",
  minVersion: "0.0.0",
  latestVersion: "0.0.0",
  pollIntervalSeconds: 5,
  backoff: { initialSeconds: 5, maxSeconds: 300, factor: 2, jitterRatio: 0.2 },
  claude: { args: ["-p"], modelFlag: "--model" },
  codex: { args: ["exec"], modelFlag: "--model" },
};

/** One pending row as genex.games lists it; a workflow parent carries no job (`runner: null`). */
export interface PendingGeneration {
  id: string;
  gameName: string;
  expiresAt: string;
  attempts: number;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  runner: RunnerJob | null;
}

/** A heartbeat's answer: the watcher's id, the version floor and the cadence. */
export interface HeartbeatResult {
  watcherId: string;
  minVersion: string;
  latestVersion: string;
  policyVersion: string;
  pollIntervalSeconds: number;
}

/** What a release or a submit came to. */
export interface PlayerReceipt {
  id: string;
  status: string;
}

/** genex.games said this watcher is too old, and named what to become. */
export class PlayerUpdateRequiredError extends Error {
  readonly minVersion: string;
  readonly latestVersion: string;
  constructor(minVersion: string, latestVersion: string) {
    super(`genex.games no longer serves this watcher (below ${minVersion}; current ${latestVersion})`);
    this.name = "PlayerUpdateRequiredError";
    this.minVersion = minVersion;
    this.latestVersion = latestVersion;
  }
}

/** genex.games refused the player credential: only a person with a browser can fix it. */
export class PlayerAuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`genex.games refused this Mac's player credential (HTTP ${status}${code ? `, ${code}` : ""})`);
    this.name = "PlayerAuthError";
    this.status = status;
    this.code = code;
  }
}

/** Any other refusal, or an answer not in the shape the loop reads, with genex.games' code. */
export class PlayerApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`HTTP ${status}${code ? ` ${code}` : ""}`);
    this.name = "PlayerApiError";
    this.status = status;
    this.code = code;
  }
}

/** The code an answer that does not read carries. */
export const UNREADABLE_ANSWER = "unreadable_answer";

/** The seven player routes. */
export interface PlayerClient {
  /** The version every call reports. */
  readonly version: string;
  /** The served runner policy; throws {@link PlayerApiError} when it does not read. */
  policy(): Promise<PlayerPolicy>;
  /** "I am here, this is what I can run"; also how a watcher learns its id. */
  heartbeat(input: {
    watcherId?: string;
    platform: string;
    runners: string[];
    label?: string;
  }): Promise<HeartbeatResult>;
  /** Everything waiting on one funding lane; rows that do not read are left out. */
  pending(provider: PlayerProvider): Promise<PendingGeneration[]>;
  /** Take a row for a bounded lease (idempotent for the holder; 409 otherwise); null when the answer did not read. */
  claim(id: string, provider: PlayerProvider, watcherId: string): Promise<PendingGeneration | null>;
  /** Hand a row back unfinished; `rate_limited` parks the budget behind it. */
  release(
    id: string,
    provider: PlayerProvider,
    input: { watcherId: string; reason: PlayerRelease; retryAfterSeconds?: number },
  ): Promise<PlayerReceipt>;
  /** The answer, under the lease holder's id. */
  submit(id: string, provider: PlayerProvider, watcherId: string, output: unknown): Promise<PlayerReceipt>;
}

/** What the client is made of. */
export interface PlayerClientOptions {
  /** The API origin, e.g. `https://api.genex.games`. */
  api: string;
  token: string;
  version: string;
  /** Test seam: the fetch used. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The player routes. */
const PlayerRoute = {
  Policy: "/api/runtime/player/policy",
  Heartbeat: "/api/runtime/player/watchers/heartbeat",
  Pending: "/api/runtime/external/generations",
  claim: (id: string) => `/api/runtime/external/generations/${encodeURIComponent(id)}/claim`,
  release: (id: string) => `/api/runtime/external/generations/${encodeURIComponent(id)}/release`,
  result: (id: string) => `/api/runtime/external/generations/${encodeURIComponent(id)}/result`,
} as const;

const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UPGRADE_REQUIRED = 426;

/** The client over `options`. */
export function createPlayerClient(options: PlayerClientOptions): PlayerClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const call = async (route: string, body?: unknown, provider?: PlayerProvider): Promise<unknown> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
      [PLAYER_VERSION_HEADER]: options.version,
      ...(provider ? { [EXTERNAL_PROVIDER_HEADER]: provider } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    };
    const res = await fetchImpl(options.api + route, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = await readAnswer(res);
    if (res.ok) return answer;
    throw refusal(res.status, answer);
  };

  return {
    version: options.version,
    policy: async () => {
      const policy = readPlayerPolicy(await call(PlayerRoute.Policy));
      if (!policy) throw new PlayerApiError(200, UNREADABLE_ANSWER);
      return policy;
    },
    heartbeat: async (input) => {
      const beat = readHeartbeat(
        await call(PlayerRoute.Heartbeat, {
          ...(input.watcherId ? { watcherId: input.watcherId } : {}),
          version: options.version,
          platform: input.platform,
          runners: input.runners,
          ...(input.label ? { label: input.label } : {}),
        }),
      );
      if (!beat) throw new PlayerApiError(200, UNREADABLE_ANSWER);
      return beat;
    },
    pending: async (provider) => readPendingGenerations(await call(PlayerRoute.Pending, undefined, provider)),
    claim: async (id, provider, watcherId) =>
      readPendingGeneration(await call(PlayerRoute.claim(id), { watcherId }, provider)),
    release: async (id, provider, input) => {
      const retry = clampRetrySeconds(input.retryAfterSeconds);
      const body = { watcherId: input.watcherId, reason: input.reason, ...(retry ? { retryAfterSeconds: retry } : {}) };
      return readReceipt(await call(PlayerRoute.release(id), body, provider), id);
    },
    submit: async (id, provider, watcherId, output) =>
      readReceipt(await call(PlayerRoute.result(id), { output, watcherId }, provider), id),
  };
}

/** A wait in whole seconds the release route takes (1 to a day), or undefined for none. */
function clampRetrySeconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.round(seconds)));
}

/** An answer's JSON, read up to its cap; an empty or unparseable body reads as null. */
async function readAnswer(res: Response): Promise<unknown> {
  if (!res.body) return null;
  const bytes = await readCapped(res.body.getReader(), MAX_ANSWER_BYTES, "genex.games answered too much");
  if (bytes.length === 0) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

/** The error a non-2xx answer becomes. */
function refusal(status: number, answer: unknown): Error {
  const body = isPlainRecord(answer) ? answer : {};
  const code = typeof body.error === "string" && TOKEN_RE.test(body.error) ? body.error : "";
  if (status === HTTP_UPGRADE_REQUIRED) {
    return new PlayerUpdateRequiredError(
      versionOr(body.minVersion, "unknown"),
      versionOr(body.latestVersion, "latest"),
    );
  }
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return new PlayerAuthError(status, code);
  return new PlayerApiError(status, code);
}

const versionOr = (raw: unknown, fallback: string): string =>
  typeof raw === "string" && TOKEN_RE.test(raw) ? raw : fallback;

const isId = (raw: unknown): raw is string => typeof raw === "string" && ID_RE.test(raw);
const isDate = (raw: unknown): raw is string => typeof raw === "string" && Number.isFinite(Date.parse(raw));
const isCount = (raw: unknown, max: number): raw is number =>
  typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= max;
const isPositive = (raw: unknown, max: number): raw is number => isCount(raw, max) && raw > 0;
const isText = (raw: unknown, max: number): raw is string => typeof raw === "string" && raw.length <= max;

/** A job's model, or null: a family the watcher answers and a CLI model that can never read as a flag. */
function readRunnerModel(raw: unknown): RunnerModel | null {
  if (!isPlainRecord(raw)) return null;
  const family = readMember(PlayerProvider, raw.family);
  const { id, cliModel } = raw;
  if (!family || !isText(id, 200) || id === "" || typeof cliModel !== "string" || !CLI_MODEL_RE.test(cliModel))
    return null;
  return { id, family, cliModel };
}

/** A job's schema: absent, or a bounded plain JSON tree with no prototype key. */
function schemaOf(raw: Record<string, unknown>): { schema?: unknown } | null {
  if (!Object.hasOwn(raw, "schema") || raw.schema === undefined) return {};
  return isBoundedJson(raw.schema, SCHEMA_BOUNDS) ? { schema: raw.schema } : null;
}

/** A job's texts and numbers, or null when one is out of shape. */
function readJobBody(raw: Record<string, unknown>) {
  const { system, user, maxOutputTokens, leaseSeconds } = raw;
  const outputFormat = readMember(RunnerOutputFormat, raw.outputFormat);
  const mode = readMember(RunnerMode, raw.mode);
  if (!outputFormat || !mode || !isText(system, MAX_SYSTEM_CHARS) || !isText(user, MAX_USER_CHARS)) return null;
  if (!isPositive(maxOutputTokens, MAX_OUTPUT_TOKENS) || !isPositive(leaseSeconds, MAX_LEASE_SECONDS)) return null;
  return { system, user, outputFormat, maxOutputTokens, mode, leaseSeconds };
}

/** One job as genex.games composed it, or null when any part of it is out of shape. */
export function readRunnerJob(raw: unknown): RunnerJob | null {
  if (!isPlainRecord(raw)) return null;
  const body = readJobBody(raw);
  const model = readRunnerModel(raw.model);
  const schema = schemaOf(raw);
  const grantId = raw.grantId ?? null;
  if (!body || !model || !schema || (grantId !== null && !isId(grantId))) return null;
  return {
    system: body.system,
    user: body.user,
    outputFormat: body.outputFormat,
    ...schema,
    model,
    maxOutputTokens: body.maxOutputTokens,
    mode: body.mode,
    grantId,
    leaseSeconds: body.leaseSeconds,
  };
}

/** One pending row, or null: its id, its times and, when it carries one, its job must read. */
export function readPendingGeneration(raw: unknown): PendingGeneration | null {
  if (!isPlainRecord(raw)) return null;
  const { id, gameName, expiresAt, attempts } = raw;
  const claimedBy = raw.claimedBy ?? null;
  const leaseExpiresAt = raw.leaseExpiresAt ?? null;
  if (!isId(id) || !isText(gameName, MAX_GAME_NAME_CHARS) || !isDate(expiresAt) || !isCount(attempts, 1000))
    return null;
  if ((claimedBy !== null && !isId(claimedBy)) || (leaseExpiresAt !== null && !isDate(leaseExpiresAt))) return null;
  const hasJob = raw.runner !== undefined && raw.runner !== null;
  const runner = hasJob ? readRunnerJob(raw.runner) : null;
  if (hasJob && !runner) return null;
  return { id, gameName, expiresAt, attempts, claimedBy, leaseExpiresAt, runner };
}

/** The rows of a queue listing that read, at most {@link MAX_PENDING_ROWS}. */
export function readPendingGenerations(raw: unknown): PendingGeneration[] {
  if (!isPlainRecord(raw) || !Array.isArray(raw.generations)) return [];
  const rows: PendingGeneration[] = [];
  for (const item of raw.generations) {
    const row = readPendingGeneration(item);
    if (row) rows.push(row);
    if (rows.length === MAX_PENDING_ROWS) break;
  }
  return rows;
}

/** One CLI's served invocation, or null: bounded args with no control character, and a long-option model flag. */
function readBinaryPolicy(raw: unknown): RunnerBinaryPolicy | null {
  if (!isPlainRecord(raw)) return null;
  const { args, modelFlag } = raw;
  const goodArg = (arg: unknown) =>
    typeof arg === "string" && arg.length <= MAX_POLICY_ARG_CHARS && !CONTROL_RE.test(arg);
  const argsRead = args === undefined || (Array.isArray(args) && args.length <= MAX_POLICY_ARGS && args.every(goodArg));
  const flagRead = modelFlag === undefined || (typeof modelFlag === "string" && MODEL_FLAG_RE.test(modelFlag));
  if (!argsRead || !flagRead) return null;
  return {
    ...(args === undefined ? {} : { args: [...(args as string[])] }),
    ...(modelFlag === undefined ? {} : { modelFlag }),
  };
}

/** A backoff in range, or null. */
function readBackoff(raw: unknown): PlayerPolicy["backoff"] | null {
  if (!isPlainRecord(raw)) return null;
  const { initialSeconds, maxSeconds, factor, jitterRatio } = raw;
  const seconds = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_RETRY_SECONDS;
  if (!seconds(initialSeconds) || !seconds(maxSeconds) || maxSeconds < initialSeconds) return null;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 1 || factor > 10) return null;
  if (typeof jitterRatio !== "number" || !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1)
    return null;
  return { initialSeconds, maxSeconds, factor, jitterRatio };
}

/** A served CLI policy: absent is fine; present, it must read. */
function binaryPolicyOf(raw: unknown): { ok: boolean; value?: RunnerBinaryPolicy } {
  if (raw === undefined) return { ok: true };
  const value = readBinaryPolicy(raw);
  return value ? { ok: true, value } : { ok: false };
}

/** The served runner policy, or null when its numbers or its args are out of shape. */
export function readPlayerPolicy(raw: unknown): PlayerPolicy | null {
  if (!isPlainRecord(raw)) return null;
  const { version, minVersion, latestVersion, pollIntervalSeconds } = raw;
  const tokens = [version, minVersion, latestVersion].every((t) => typeof t === "string" && TOKEN_RE.test(t));
  const backoff = readBackoff(raw.backoff);
  const claude = binaryPolicyOf(raw.claude);
  const codex = binaryPolicyOf(raw.codex);
  if (!tokens || !isPositive(pollIntervalSeconds, MAX_POLL_SECONDS) || !backoff || !claude.ok || !codex.ok) return null;
  return {
    version: version as string,
    minVersion: minVersion as string,
    latestVersion: latestVersion as string,
    pollIntervalSeconds,
    backoff,
    ...(claude.value ? { claude: claude.value } : {}),
    ...(codex.value ? { codex: codex.value } : {}),
  };
}

/** A heartbeat's answer, or null when its watcher id could not be one; a missing cadence takes the default. */
export function readHeartbeat(raw: unknown): HeartbeatResult | null {
  if (!isPlainRecord(raw) || !isId(raw.watcherId)) return null;
  const cadence = raw.pollIntervalSeconds;
  return {
    watcherId: raw.watcherId,
    minVersion: versionOr(raw.minVersion, "0.0.0"),
    latestVersion: versionOr(raw.latestVersion, "0.0.0"),
    policyVersion: versionOr(raw.policyVersion, ""),
    pollIntervalSeconds: isPositive(cadence, MAX_POLL_SECONDS) ? cadence : DEFAULT_POLL_SECONDS,
  };
}

/** A release's or a submit's answer: its status when it reads, else `unknown`. */
function readReceipt(raw: unknown, id: string): PlayerReceipt {
  const status =
    isPlainRecord(raw) && typeof raw.status === "string" && TOKEN_RE.test(raw.status) ? raw.status : "unknown";
  return { id, status };
}
