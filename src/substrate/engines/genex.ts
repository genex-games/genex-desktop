/**
 * Building with Genex: Claude Code on the person's Genex credits (owner, 2026-10-28). This is the
 * part of the Genex engine that is not Claude Code's: whether the account may build now and why
 * not (`GET /api/desktop/llm/status`), the models genex.games offers, the account's monthly
 * credits for the usage popover, and the relay leases each session runs through (`genex-relay.ts`).
 * `ClaudeCodeEngine` takes it as its `gateway` and runs the same CLI on it, under the Genex id.
 *
 * A status read is reused for a few seconds and joined while in flight: the registry asks on every
 * describe. A call genex.games refuses moves the status at once, so the chat's notice follows the
 * refusal rather than the next read. Electron-free.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { EngineStatusCode, EngineStatusReason } from "../../shared/engine-descriptor.ts";
import {
  GENEX_HELPER_MODEL,
  GENEX_MODELS,
  GenexAccess,
  GenexBuildRoute,
  type GenexModel,
  isGenexAccess,
} from "../../shared/genex-build.ts";
import { t } from "../../shared/i18n.ts";
import type { ProviderUsage } from "../../shared/provider-usage.ts";
import { EngineId } from "../../shared/providers.ts";
import { createGenexRelay, type GenexLease, type GenexRelay } from "./genex-relay.ts";
import type { EngineModel, EngineStatus } from "./types.ts";

/** How long a status read is reused. */
const STATUS_FRESH_MS = 5 * SECOND_MS;
/** How long a status read may take before the lane reads as unreachable. */
const STATUS_TIMEOUT_MS = 10 * SECOND_MS;
/** How long a credits read is reused for the usage popover. */
const USAGE_FRESH_MS = MINUTE_MS;
/** The credits route the usage popover reads (the account's balance and monthly refill). */
const CREDITS_ROUTE = "/api/credits/me";
/** The context and answer every Genex model is offered with; genex.games bounds the real call. */
const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 64_000;
/** The longest model id and name taken from genex.games. */
const MODEL_ID_MAX = 80;
const MODEL_NAME_MAX = 60;
/** The usage window's id: the account's monthly credits. */
const CREDITS_WINDOW = "credits";

const MESSAGE = {
  Ready: () => t("Building with Genex credits."),
  SignIn: () => t("Sign in to Genex to build with credits."),
  VerifyEmail: () => t("Verify your email on genex.games to build with credits."),
  NeedsPlan: () => t("Building with Genex needs Pro or a credit pack."),
  OutOfCredits: () => t("You're out of Genex credits."),
  Paused: () => t("Building with Genex is paused for now. Your work so far is saved."),
  NotOffered: () => t("Building with Genex isn't available yet."),
  Unreachable: () => t("genex.games couldn't be reached."),
  MonthlyCredits: () => t("Monthly credits"),
} as const;

/** What the lane needs from the app: where genex.games is and the person's sign-in to it. */
export interface GenexLaneDeps {
  /** genex.games's API origin. */
  api: string;
  /** The person's Genex token while signed in. */
  token(): Promise<string | undefined>;
  /** genex.games refused `token` itself: the app's Genex account reads as ended. */
  refused?(token: string): void;
  /** The lane's status moved (a refusal, a purchase seen): the engines are described again. */
  onChange?(): void;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The engine status for an access word. */
export function genexStatus(access: GenexAccess): EngineStatus {
  switch (access) {
    case GenexAccess.Ready:
      return { code: EngineStatusCode.Ready, detail: MESSAGE.Ready() };
    case GenexAccess.SignIn:
      return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.SignIn(), reason: EngineStatusReason.NotSignedIn };
    case GenexAccess.VerifyEmail:
      return {
        code: EngineStatusCode.NeedsLogin,
        detail: MESSAGE.VerifyEmail(),
        reason: EngineStatusReason.VerifyEmail,
      };
    case GenexAccess.NeedsPlan:
      return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.NeedsPlan(), reason: EngineStatusReason.NeedsPlan };
    case GenexAccess.OutOfCredits:
      return {
        code: EngineStatusCode.NeedsLogin,
        detail: MESSAGE.OutOfCredits(),
        reason: EngineStatusReason.OutOfCredits,
      };
    default:
      return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.Paused(), reason: EngineStatusReason.Paused };
  }
}

/** The status while genex.games offers no building with credits: the app hides Genex. */
const NOT_OFFERED: EngineStatus = {
  code: EngineStatusCode.NotInstalled,
  get detail() {
    return MESSAGE.NotOffered();
  },
  reason: EngineStatusReason.NotOffered,
};

/** The models a status answer lists, or null for an answer that lists none it can read. */
function modelsOf(value: unknown): GenexModel[] | null {
  if (!Array.isArray(value)) return null;
  const models = value.flatMap((row: unknown) => {
    if (!row || typeof row !== "object") return [];
    const { id, name } = row as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !id || id.length > MODEL_ID_MAX) return [];
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, MODEL_NAME_MAX) : id;
    return [{ id, label }];
  });
  return models.length ? models : null;
}

/** The account's monthly credits as one usage window, or null when it has no monthly refill. */
export function creditsUsage(body: unknown, measuredAt: string): ProviderUsage | null {
  if (!body || typeof body !== "object") return null;
  const { spendable, balance, refillTo, refillAt } = body as Record<string, unknown>;
  const left = typeof spendable === "number" ? spendable : balance;
  if (typeof left !== "number" || typeof refillTo !== "number" || refillTo <= 0) return null;
  const used = Math.round(100 * (1 - left / refillTo));
  const resets = typeof refillAt === "string" && Number.isFinite(Date.parse(refillAt)) ? { resetsAt: refillAt } : {};
  return {
    measuredAt,
    windows: [
      { id: CREDITS_WINDOW, label: MESSAGE.MonthlyCredits(), percent: Math.max(0, Math.min(100, used)), ...resets },
    ],
  };
}

/** The Genex lane over `deps`. */
export function createGenexLane(deps: GenexLaneDeps) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let models: GenexModel[] = [...GENEX_MODELS];
  let last: { status: EngineStatus; at: number } | null = null;
  let reading: Promise<EngineStatus> | null = null;
  let usage: { value: ProviderUsage | null; at: number } | null = null;

  const settle = (status: EngineStatus): EngineStatus => {
    const moved = last !== null && (last.status.code !== status.code || last.status.reason !== status.reason);
    last = { status, at: now() };
    if (moved) deps.onChange?.();
    return status;
  };

  const ask = async (): Promise<EngineStatus> => {
    const token = await deps.token();
    let res: Response;
    try {
      res = await doFetch(new URL(GenexBuildRoute.Status, deps.api), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
    } catch {
      return { code: EngineStatusCode.Error, detail: MESSAGE.Unreachable(), reason: EngineStatusReason.CheckFailed };
    }
    if (res.status === 404) return NOT_OFFERED;
    const body = (await res.json().catch(() => null)) as { access?: unknown; models?: unknown } | null;
    if (!res.ok || !isGenexAccess(body?.access))
      return { code: EngineStatusCode.Error, detail: MESSAGE.Unreachable(), reason: EngineStatusReason.CheckFailed };
    models = modelsOf(body.models) ?? models;
    return genexStatus(body.access);
  };

  const relay: GenexRelay = createGenexRelay({
    api: deps.api,
    token: deps.token,
    models: () => models.map((model) => model.id),
    onRefusal: (reason, token) => {
      if (reason === GenexAccess.SignIn && token) deps.refused?.(token);
      settle(genexStatus(reason));
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  return {
    id: EngineId.Genex,
    label: "Genex",
    /** Whether the account may build now; `fresh` asks genex.games again. */
    async status(fresh = false): Promise<EngineStatus> {
      if (!fresh && last && now() - last.at < STATUS_FRESH_MS) return last.status;
      reading ??= ask()
        .then(settle)
        .finally(() => {
          reading = null;
        });
      return reading;
    },
    /** The models genex.games offers, as the engine lists them. */
    models(): EngineModel[] {
      return models.map((model) => ({
        id: model.id,
        label: model.label,
        contextWindow: CONTEXT_WINDOW,
        maxTokens: MAX_TOKENS,
        supportsTools: true,
        supportsVision: true,
        supportsThinking: true,
      }));
    },
    /** The default model, and every helper's. */
    defaultModel(): string {
      return models[0]?.id ?? GENEX_HELPER_MODEL;
    },
    /** A relay lease for one session, named by its chat. */
    open(chat: string): Promise<GenexLease> {
      return relay.open({ chat });
    },
    /** The account's monthly credits; null while signed out or with no monthly refill. */
    async readUsage(): Promise<ProviderUsage | null> {
      if (usage && now() - usage.at < USAGE_FRESH_MS) return usage.value;
      const token = await deps.token();
      if (!token) return null;
      const res = await doFetch(new URL(CREDITS_ROUTE, deps.api), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(MESSAGE.Unreachable());
      const value = creditsUsage(await res.json(), new Date(now()).toISOString());
      usage = { value, at: now() };
      return value;
    },
    /** Forget every read, so the next one asks genex.games again (a sign-in, a purchase). */
    forget(): void {
      last = null;
      usage = null;
    },
    /** Stop the relay. */
    close: (): Promise<void> => relay.close(),
  };
}

/** The lane as `createGenexLane` makes it: what `ClaudeCodeEngine` runs on as its `gateway`. */
export type GenexLane = ReturnType<typeof createGenexLane>;
