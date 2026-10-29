/**
 * Play-time AI's grants and the person's limits, in `userData/game-ai/` (a protected path: no agent
 * process can write it, so no agent can grant itself AI or raise a limit).
 *
 * A grant is keyed by profile (each profile has its own userData), game and door. A game holds one
 * live grant at a time; a new one replaces it under a lock. There is no TTL: a grant ends when the
 * person turns the game's AI off, another model replaces it, or the payer changes. First-use consent
 * is remembered per (game, door), so a person asked once is not asked again for that door, until the
 * payer behind it changes.
 *
 * Money (design v3): a call reserves its worst case and the reservation is on disk before the call
 * leaves main, so a crash or a quit never refunds; it settles at what the provider billed, and a reply
 * the game could not use costs nothing, its repair included (D7). The person's limits are a daily
 * alert per game in credits (the game pauses there until they say Keep playing, once a day) and the
 * OpenRouter monthly limit on their own key, across every game on it. Calls are held to per-door
 * terms: calls at once, calls a minute (a repair counts) and calls a day, through the budget ledger's
 * host-only game bucket. Every time is read from the injected clock; a clock that goes backwards
 * never resets a day's or a month's spend.
 *
 * `createGameAiSettings` keeps Settings → Play-time AI beside it: the limits above, the pick policy,
 * each plan's keep-for-building share and the switches, with auto top-up read through genex.games.
 */
import { randomBytes } from "node:crypto";
import { DAY_MS, MINUTE_MS } from "../../shared/duration.ts";
import {
  AiConsent,
  AiDoor,
  AiErrorCode,
  type AiGameKey,
  AiGrantStatus,
  type AiModelRef,
  AiRequirement,
  type AiBudgetView,
  AI_ID_RE,
  isPlainRecord,
  microsOfCredits,
  playGameKey,
  readAiGameKey,
  readMember,
} from "../../shared/game-ai.ts";
import {
  AI_DEFAULT_DAILY_ALERT_CREDITS,
  AI_DEFAULT_KEEP_FOR_BUILDING_PERCENT,
  AiPickPolicy,
  consentTapped,
  type GameAiSettingsPatch,
  type GameAiSettingsView,
  readAiModelRef,
  readGameAiSettingsPatch,
} from "../../shared/game-ai-views.ts";
import { atomicWriteJson, AsyncLock, readJsonIfExists } from "../../substrate/fsx.ts";
import type {
  AiCallCost,
  AiGrantRecord,
  AiHold,
  AiHoldResult,
  GameAiClock,
  GameAiGrants,
  GameAiSettingsStore,
  GenexAiPlatform,
} from "./types.ts";

/** The grants' file and the settings' file, in `userData/game-ai/`. */
export const GRANTS_FILE = "grants.json";
export const SETTINGS_FILE = "settings.json";

/** The wire version of the grants file. */
const GRANTS_FILE_VERSION = 1;
/** The most grant rows the file keeps; replaced grants of past months are dropped first. */
const MAX_GRANT_ROWS = 2_000;
/** The window a grant's calls-a-minute is counted over. */
const RATE_WINDOW_MS = MINUTE_MS;
/** A grant id's random part, in bytes. */
const GRANT_ID_BYTES = 12;
/** A UTC day (`2026-10-20`) and month (`2026-10`) as the file keeps them. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** How many calls a grant on one door may make: at once, a minute, and a day (null: no daily cap). */
interface GrantTerms {
  concurrency: number;
  perMinute: number;
  perDay: number | null;
}

/** A door that bills: two at once and thirty a minute; its money is held by the person's limits. */
const PAID_TERMS: GrantTerms = { concurrency: 2, perMinute: 30, perDay: null };
/** A free model on this Mac: eight at once, 120 a minute, 500 a day. */
const LOCAL_TERMS: GrantTerms = { concurrency: 8, perMinute: 120, perDay: 500 };
/** Saved playtests and fixtures cost nothing and reach nothing. */
const REPLAY_TERMS: GrantTerms = { concurrency: 8, perMinute: 120, perDay: null };

/** Each door's terms. The plan: one at a time and 50 a day, so a game never eats the builder's plan. */
const GRANT_TERMS = {
  [AiDoor.Local]: LOCAL_TERMS,
  [AiDoor.OpenCode]: PAID_TERMS,
  [AiDoor.Byok]: PAID_TERMS,
  [AiDoor.Plan]: { concurrency: 1, perMinute: 30, perDay: 50 },
  [AiDoor.PlanWatcher]: PAID_TERMS,
  [AiDoor.GenexCredits]: PAID_TERMS,
  [AiDoor.GenexDev]: PAID_TERMS,
  [AiDoor.Tape]: REPLAY_TERMS,
  [AiDoor.Fixture]: REPLAY_TERMS,
} as const satisfies Record<AiDoor, GrantTerms>;

/** What a grant's status answers a reservation with; null when it may spend. */
const HOLD_REFUSAL = {
  [AiGrantStatus.Active]: null,
  [AiGrantStatus.WaitingForPlan]: AiErrorCode.WaitingForPlan,
  [AiGrantStatus.Paused]: AiErrorCode.Paused,
  [AiGrantStatus.Off]: AiErrorCode.Off,
  [AiGrantStatus.Replaced]: AiErrorCode.ConsentRequired,
} as const satisfies Record<AiGrantStatus, AiErrorCode | null>;

/** The person's limits, in USD micros, as Settings holds them now. */
export interface GrantLimits {
  /** A game pauses when it has spent this much today; null: no alert. */
  dailyAlertMicros: number | null;
  /** The person's own OpenRouter key stops at this much a calendar month, across games; null: no limit. */
  openRouterMonthlyMicros: number | null;
}

/** The budget ledger's host-only game bucket (`substrate/budget.ts` `BudgetLedger`). */
export interface GameCallBucket {
  admitGame(game: string, cap: number | null): { ok: true } | { ok: false; reason: string };
  recordGame(game: string, tokens: number): void;
}

/** What the grants store runs on. */
export interface GameAiGrantsOptions {
  /** `userData/game-ai/grants.json`. */
  file: string;
  clock: GameAiClock;
  calls: GameCallBucket;
  limits(): Promise<GrantLimits>;
}

/** The grants file. */
interface GrantsFile {
  v: typeof GRANTS_FILE_VERSION;
  grants: AiGrantRecord[];
  /** First-use consent given, per game and door. */
  consents: Array<{ game: AiGameKey; door: AiDoor }>;
  /** Games whose AI the person turned off before any grant. */
  off: AiGameKey[];
  /** The day the person said Keep playing at a game's daily alert. */
  alerts: Record<string, string>;
}

/** The grants store, with its load. */
export type GameAiGrantsStore = GameAiGrants & {
  load(): Promise<void>;
};

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const consentKey = (game: AiGameKey, door: AiDoor): string => `${door} ${game}`;
const isMicros = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isIsoTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Milliseconds from `now` to the next UTC midnight. */
const untilNextDay = (now: number): number => DAY_MS - (now % DAY_MS);

/** Milliseconds from `now` to the first instant of the next UTC month. */
function untilNextMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - now;
}

/** A grant row from the file as untrusted counts: every field read, anything off drops the row. */
function readGrantRow(raw: unknown): AiGrantRecord | null {
  if (!isPlainRecord(raw)) return null;
  const game = readAiGameKey(raw.game);
  const door = readMember(AiDoor, raw.door);
  const model = readAiModelRef(raw.model);
  const status = readMember(AiGrantStatus, raw.status);
  const consent = readMember(AiConsent, raw.consent);
  const requires = readMember(AiRequirement, raw.requires);
  const { id, consentedAt, lastUsedAt, spentMicros, todayMicros, day, monthMicros, month } = raw;
  if (!game || !door || !model || !status || !consent || !requires || model.door !== door) return null;
  if (typeof id !== "string" || !AI_ID_RE.test(id) || !isIsoTime(consentedAt)) return null;
  if (lastUsedAt !== null && !isIsoTime(lastUsedAt)) return null;
  if (!isMicros(spentMicros) || !isMicros(todayMicros) || !isMicros(monthMicros)) return null;
  if (typeof day !== "string" || !DAY_RE.test(day) || typeof month !== "string" || !MONTH_RE.test(month)) return null;
  return {
    id,
    game,
    door,
    model,
    status,
    consent,
    consentedAt,
    lastUsedAt,
    spentMicros,
    todayMicros,
    day,
    monthMicros,
    month,
    requires,
  };
}

/** The grant rows of a file: valid, unique by id, at most one live grant per game (the last wins). */
function readGrantRows(raw: unknown): AiGrantRecord[] {
  if (!Array.isArray(raw)) return [];
  const rows: AiGrantRecord[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(-MAX_GRANT_ROWS)) {
    const row = readGrantRow(item);
    if (!row || ids.has(row.id)) continue;
    ids.add(row.id);
    rows.push(row);
  }
  const liveOf = new Map<AiGameKey, string>();
  for (const row of rows) if (row.status !== AiGrantStatus.Replaced) liveOf.set(row.game, row.id);
  return rows.map((row) =>
    row.status !== AiGrantStatus.Replaced && liveOf.get(row.game) !== row.id
      ? { ...row, status: AiGrantStatus.Replaced }
      : row,
  );
}

function readConsents(raw: unknown): GrantsFile["consents"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isPlainRecord(item)) return [];
    const game = readAiGameKey(item.game);
    const door = readMember(AiDoor, item.door);
    return game && door ? [{ game, door }] : [];
  });
}

function readOff(raw: unknown): AiGameKey[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const game = readAiGameKey(item);
    return game ? [game] : [];
  });
}

function readAlerts(raw: unknown): Record<string, string> {
  const alerts: Record<string, string> = {};
  if (!isPlainRecord(raw)) return alerts;
  for (const [key, day] of Object.entries(raw)) {
    const game = readAiGameKey(key);
    if (game && typeof day === "string" && DAY_RE.test(day)) alerts[game] = day;
  }
  return alerts;
}

/** A grants file read as hostile input; an unreadable or missing file is an empty store. */
async function readGrantsFile(file: string): Promise<GrantsFile> {
  const raw = await readJsonIfExists<unknown>(file).catch(() => null);
  const body = isPlainRecord(raw) ? raw : {};
  return {
    v: GRANTS_FILE_VERSION,
    grants: readGrantRows(body.grants),
    consents: readConsents(body.consents),
    off: readOff(body.off),
    alerts: readAlerts(body.alerts),
  };
}

/** A grant with today's and this month's spend rolled forward to `now`; never backwards. */
function rolled(grant: AiGrantRecord, now: number): AiGrantRecord {
  const day = dayOf(now);
  const month = monthOf(now);
  const newDay = day > grant.day;
  const newMonth = month > grant.month;
  if (!newDay && !newMonth) return grant;
  return {
    ...grant,
    ...(newDay ? { day, todayMicros: 0 } : {}),
    ...(newMonth ? { month, monthMicros: 0 } : {}),
  };
}

/** A grant's spend moved by `micros` (negative gives back), on the day and month it was held in. */
function spend(grant: AiGrantRecord, micros: number, held: { day: string; month: string }): AiGrantRecord {
  return {
    ...grant,
    spentMicros: Math.max(0, grant.spentMicros + micros),
    todayMicros: grant.day === held.day ? Math.max(0, grant.todayMicros + micros) : grant.todayMicros,
    monthMicros: grant.month === held.month ? Math.max(0, grant.monthMicros + micros) : grant.monthMicros,
  };
}

/** A new grant id. */
const newGrantId = (): string => `g_${randomBytes(GRANT_ID_BYTES).toString("base64url")}`;

/** The grants store over `options.file`; call `load` once before use. */
export function createGameAiGrants(options: GameAiGrantsOptions): GameAiGrantsStore {
  return new GrantsStore(options);
}

/** A reservation's place in time: the day and month its worst case was added to. */
interface HeldOn {
  day: string;
  month: string;
}

/** Replaced grants of past months no longer count toward anything: dropped, oldest first, past the cap. */
function pruned(grants: AiGrantRecord[], now: number): AiGrantRecord[] {
  const month = monthOf(now);
  const kept = grants.filter((grant) => grant.status !== AiGrantStatus.Replaced || grant.month >= month);
  return kept.slice(-MAX_GRANT_ROWS);
}

/** A fresh grant, agreed now. */
function newGrant(
  game: AiGameKey,
  model: AiModelRef,
  consent: AiConsent,
  requires: AiRequirement,
  now: number,
): AiGrantRecord {
  return {
    id: newGrantId(),
    game,
    door: model.door,
    model: { ...model },
    status: AiGrantStatus.Active,
    consent,
    consentedAt: new Date(now).toISOString(),
    lastUsedAt: null,
    spentMicros: 0,
    todayMicros: 0,
    day: dayOf(now),
    monthMicros: 0,
    month: monthOf(now),
    requires,
  };
}

/** The grants of one profile, serialised by one lock; memory never runs ahead of the disk. */
class GrantsStore implements GameAiGrantsStore {
  readonly #options: GameAiGrantsOptions;
  readonly #lock = new AsyncLock();
  #state: GrantsFile = { v: GRANTS_FILE_VERSION, grants: [], consents: [], off: [], alerts: {} };
  /** Calls running now, per grant. */
  readonly #running = new Map<string, number>();
  /** When each call of the last minute started, per grant; a repair adds one. */
  readonly #recent = new Map<string, number[]>();

  constructor(options: GameAiGrantsOptions) {
    this.#options = options;
  }

  async load(): Promise<void> {
    this.#state = await readGrantsFile(this.#options.file);
  }

  live(game: AiGameKey): AiGrantRecord | null {
    const live = this.#liveOf(game);
    return live ? { ...live } : null;
  }

  isOff(game: AiGameKey): boolean {
    return this.#state.off.includes(game) || this.#liveOf(game)?.status === AiGrantStatus.Off;
  }

  consented(game: AiGameKey, door: AiDoor): boolean {
    return this.#state.consents.some((row) => consentKey(row.game, row.door) === consentKey(game, door));
  }

  list(): AiGrantRecord[] {
    return this.#state.grants.map((row) => ({ ...row }));
  }

  view(grant: AiGrantRecord): AiBudgetView {
    return {
      id: grant.id,
      status: grant.status,
      door: grant.door,
      spentMicros: grant.spentMicros,
      planUsedPercent: null,
      planResetsAt: null,
    };
  }

  grant(game: AiGameKey, model: AiModelRef, consent: AiConsent, requires: AiRequirement): Promise<AiGrantRecord> {
    return this.#lock.run(async () => {
      const now = this.#options.clock.now();
      const record = newGrant(game, model, consent, requires, now);
      const state = this.#state;
      const others = state.grants.map((row) =>
        row.game === game && row.status !== AiGrantStatus.Replaced ? { ...row, status: AiGrantStatus.Replaced } : row,
      );
      const asked = consentTapped(consent) && !this.consented(game, model.door);
      await this.#commit({
        ...state,
        grants: pruned([...others, record], now),
        consents: asked ? [...state.consents, { game, door: model.door }] : state.consents,
        off: state.off.filter((key) => key !== game),
      });
      return { ...record };
    });
  }

  reserve(asked: AiGrantRecord, worst: number): Promise<AiHoldResult> {
    return this.#lock.run(async () => {
      const now = this.#options.clock.now();
      const grant = this.#byId(asked.id);
      if (!grant) return { ok: false, code: AiErrorCode.ConsentRequired, retryAfterMs: null };
      const problem = await this.#holdProblem(grant, worst, now);
      if (problem) return { ok: false, ...problem };
      // Counted last: a refusal above has no side effect.
      const admitted = this.#options.calls.admitGame(grant.game, GRANT_TERMS[grant.door].perDay);
      if (!admitted.ok) return { ok: false, code: AiErrorCode.RateLimited, retryAfterMs: untilNextDay(now) };
      const current = rolled(grant, now);
      const held = { day: current.day, month: current.month };
      await this.#commit(this.#withGrant({ ...spend(current, worst, held), lastUsedAt: new Date(now).toISOString() }));
      this.#running.set(grant.id, (this.#running.get(grant.id) ?? 0) + 1);
      this.#lastMinute(grant.id, now).push(now);
      return { ok: true, hold: this.#holdOf(grant.id, grant.game, worst, held) };
    });
  }

  setOn(game: AiGameKey, on: boolean): Promise<AiGrantRecord | null> {
    return this.#lock.run(async () => {
      const live = this.#liveOf(game);
      const status = on ? AiGrantStatus.Active : AiGrantStatus.Off;
      const flips = live !== null && (live.status === AiGrantStatus.Off) === on;
      const next = live && flips ? this.#withGrant({ ...live, status }) : this.#state;
      // A game with a grant is off on its grant; one with none is remembered by key.
      const withoutGame = next.off.filter((key) => key !== game);
      await this.#commit({ ...next, off: on || live ? withoutGame : [...withoutGame, game] });
      return this.live(game);
    });
  }

  async setStatus(grantId: string, status: AiGrantStatus): Promise<void> {
    await this.#lock.run(async () => {
      const grant = this.#byId(grantId);
      if (!grant || grant.status === AiGrantStatus.Replaced || status === AiGrantStatus.Replaced) return;
      const keptPlaying = grant.status === AiGrantStatus.Paused && status === AiGrantStatus.Active;
      const today = dayOf(this.#options.clock.now());
      const alerts = keptPlaying ? { ...this.#state.alerts, [grant.game]: today } : this.#state.alerts;
      await this.#commit({ ...this.#withGrant({ ...grant, status }), alerts });
    });
  }

  stopDoor(door: AiDoor): Promise<AiGameKey[]> {
    return this.#lock.run(async () => {
      const state = this.#state;
      const stopped = state.grants.filter((row) => row.door === door && row.status !== AiGrantStatus.Replaced);
      const ids = new Set(stopped.map((row) => row.id));
      await this.#commit({
        ...state,
        grants: state.grants.map((row) => (ids.has(row.id) ? { ...row, status: AiGrantStatus.Replaced } : row)),
        consents: state.consents.filter((row) => row.door !== door),
      });
      return [...new Set(stopped.map((row) => row.game))];
    });
  }

  #byId(id: string): AiGrantRecord | null {
    return this.#state.grants.find((grant) => grant.id === id) ?? null;
  }

  #liveOf(game: AiGameKey): AiGrantRecord | null {
    return this.#state.grants.find((grant) => grant.game === game && grant.status !== AiGrantStatus.Replaced) ?? null;
  }

  /** Write `next` and only then make it the state. */
  async #commit(next: GrantsFile): Promise<void> {
    await atomicWriteJson(this.#options.file, next);
    this.#state = next;
  }

  #withGrant(grant: AiGrantRecord): GrantsFile {
    return { ...this.#state, grants: this.#state.grants.map((row) => (row.id === grant.id ? grant : row)) };
  }

  /** The calls of the last minute, oldest first, with older ones dropped. */
  #lastMinute(grantId: string, now: number): number[] {
    const kept = (this.#recent.get(grantId) ?? []).filter((at) => at > now - RATE_WINDOW_MS);
    this.#recent.set(grantId, kept);
    return kept;
  }

  /** This month's spend on the person's OpenRouter key, held and settled, across every game on it. */
  #keyMonthMicros(now: number): number {
    const month = monthOf(now);
    return this.#state.grants
      .filter((grant) => grant.door === AiDoor.Byok && grant.month >= month)
      .reduce((sum, grant) => sum + grant.monthMicros, 0);
  }

  /** Today's spend of one game, across its grants. */
  #gameTodayMicros(game: AiGameKey, now: number): number {
    const day = dayOf(now);
    return this.#state.grants
      .filter((grant) => grant.game === game && grant.day >= day)
      .reduce((sum, grant) => sum + grant.todayMicros, 0);
  }

  /** Why a grant may not take one more call now, or null; checks only, no side effect. */
  async #holdProblem(
    grant: AiGrantRecord,
    worst: number,
    now: number,
  ): Promise<{ code: AiErrorCode; retryAfterMs: number | null } | null> {
    const status = HOLD_REFUSAL[grant.status];
    if (status) return { code: status, retryAfterMs: null };
    if (!isMicros(worst)) return { code: AiErrorCode.DoorUnavailable, retryAfterMs: null };
    const terms = GRANT_TERMS[grant.door];
    if ((this.#running.get(grant.id) ?? 0) >= terms.concurrency) {
      return { code: AiErrorCode.Concurrency, retryAfterMs: null };
    }
    const minute = this.#lastMinute(grant.id, now);
    const oldest = minute[0];
    if (minute.length >= terms.perMinute && oldest !== undefined) {
      return { code: AiErrorCode.RateLimited, retryAfterMs: Math.max(1, oldest + RATE_WINDOW_MS - now) };
    }
    if (grant.door !== AiDoor.Byok) return null;
    const { openRouterMonthlyMicros: limit } = await this.#options.limits();
    if (limit !== null && this.#keyMonthMicros(now) + worst > limit) {
      return { code: AiErrorCode.MonthlyLimit, retryAfterMs: untilNextMonth(now) };
    }
    return null;
  }

  /** Pause a game at its daily alert, unless the person already said Keep playing today. */
  async #alertCheck(game: AiGameKey, now: number): Promise<void> {
    const grant = this.#liveOf(game);
    if (!grant || grant.status !== AiGrantStatus.Active) return;
    const { dailyAlertMicros: alert } = await this.#options.limits();
    if (alert === null || this.#state.alerts[game] === dayOf(now)) return;
    if (this.#gameTodayMicros(game, now) < alert) return;
    await this.#commit(this.#withGrant({ ...grant, status: AiGrantStatus.Paused }));
  }

  /** Close a reservation at `charge`: its worst case leaves the spend, what it cost goes in. */
  async #close(grantId: string, game: AiGameKey, worst: number, held: HeldOn, cost: AiCallCost | null) {
    const charge = cost && isMicros(cost.costMicros) ? cost.costMicros : 0;
    this.#running.set(grantId, Math.max(0, (this.#running.get(grantId) ?? 1) - 1));
    const tokens = (cost?.usage?.inputTokens ?? 0) + (cost?.usage?.outputTokens ?? 0);
    if (tokens > 0) this.#options.calls.recordGame(game, tokens);
    await this.#lock.run(async () => {
      const grant = this.#byId(grantId);
      if (!grant) return;
      const now = this.#options.clock.now();
      await this.#commit(this.#withGrant(spend(rolled(grant, now), charge - worst, held)));
      if (charge > 0) await this.#alertCheck(game, now);
    });
  }

  /** A hold over one reservation: settled or released once, whatever is called after. */
  #holdOf(grantId: string, game: AiGameKey, worst: number, held: HeldOn): AiHold {
    let open = true;
    const closeOnce = async (cost: AiCallCost | null): Promise<void> => {
      if (!open) return;
      open = false;
      await this.#close(grantId, game, worst, held, cost);
    };
    return {
      grantId,
      reservedMicros: worst,
      countRepair: () => {
        if (open) this.#recent.get(grantId)?.push(this.#options.clock.now());
      },
      // D7: a reply the game could not use (null) costs nothing, its repair included.
      settle: (cost) => closeOnce(cost),
      release: () => closeOnce(null),
    };
  }
}

// ── Settings → Play-time AI ────────────────────────────────────────────────────────────────

/** The settings Studio keeps on this Mac; the rest are read from genex.games. */
type LocalSettings = Pick<
  GameAiSettingsView,
  | "pick"
  | "dailyAlertCredits"
  | "keepForBuildingPercent"
  | "openRouterMonthlyMicros"
  | "createRouteEnabled"
  | "allowPlan"
  | "shareFitCounts"
>;

/** A fresh profile's settings (§14): AI picks the best model, a 500-credit alert, half of each plan kept for building. */
export const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  pick: AiPickPolicy.Best,
  dailyAlertCredits: AI_DEFAULT_DAILY_ALERT_CREDITS,
  keepForBuildingPercent: AI_DEFAULT_KEEP_FOR_BUILDING_PERCENT,
  openRouterMonthlyMicros: null,
  createRouteEnabled: false,
  allowPlan: false,
  shareFitCounts: false,
};

const LOCAL_KEYS = Object.keys(DEFAULT_LOCAL_SETTINGS) as ReadonlyArray<keyof LocalSettings>;

/** The settings file read as hostile input: each field through Settings' own reader, a bad one left at its default. */
async function readSettingsFile(file: string): Promise<LocalSettings> {
  const raw = await readJsonIfExists<unknown>(file).catch(() => null);
  const settings: LocalSettings = { ...DEFAULT_LOCAL_SETTINGS };
  if (!isPlainRecord(raw)) return settings;
  for (const key of LOCAL_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const read = readGameAiSettingsPatch({ [key]: raw[key] });
    if (read) Object.assign(settings, read);
  }
  return settings;
}

/** What the settings store reads from genex.games. */
export type SettingsPlatform = Pick<GenexAiPlatform, "balanceCredits" | "autoTopUp" | "setAutoTopUp" | "pausedGames">;

/** The settings store, with what the rest of the broker reads synchronously. */
export type GameAiSettings = GameAiSettingsStore & {
  load(): Promise<void>;
  /** The settings kept on this Mac, as they are now. */
  local(): LocalSettings;
  /** The person's limits in micros, for the grants store. */
  limits(): Promise<GrantLimits>;
};

/** Settings → Play-time AI over `file` (`userData/game-ai/settings.json`) and genex.games. */
export function createGameAiSettings(options: { file: string; platform: SettingsPlatform }): GameAiSettings {
  const lock = new AsyncLock();
  let local: LocalSettings = { ...DEFAULT_LOCAL_SETTINGS };

  async function view(): Promise<GameAiSettingsView> {
    // A genex.games that cannot be reached reads as signed out; Settings still opens.
    const [balanceCredits, autoTopUp, paused] = await Promise.all([
      options.platform.balanceCredits().catch(() => null),
      options.platform.autoTopUp().catch(() => null),
      options.platform.pausedGames().catch(() => []),
    ]);
    // A paused game is a Play game: its key is its genex.games project's.
    const pausedGames = paused.flatMap(({ projectId, title, pausedAt }) => {
      const game = readAiGameKey(playGameKey(projectId));
      return game ? [{ game, title, pausedAt }] : [];
    });
    return { ...local, signedIn: balanceCredits !== null, balanceCredits, pro: null, autoTopUp, pausedGames };
  }

  async function save(patch: GameAiSettingsPatch): Promise<GameAiSettingsView> {
    await lock.run(async () => {
      const { autoTopUp, ...rest } = patch;
      // Auto top-up is genex.games' own (D11): its caps and idempotency are enforced there.
      if (autoTopUp) await options.platform.setAutoTopUp(autoTopUp);
      const next = { ...local, ...rest };
      await atomicWriteJson(options.file, next);
      local = next;
    });
    return view();
  }

  return {
    load: async () => {
      local = await readSettingsFile(options.file);
    },
    local: () => ({ ...local }),
    limits: async () => ({
      dailyAlertMicros: local.dailyAlertCredits === null ? null : microsOfCredits(local.dailyAlertCredits),
      openRouterMonthlyMicros: local.openRouterMonthlyMicros,
    }),
    view,
    save,
  };
}
