import type { ModelCatalogStatus } from "./model-catalog.ts";
/**
 * What the UI knows about an engine: its status, its models and — for a subscription — which login
 * Studio uses. `substrate/engines/registry.ts` builds these (`EngineRegistry.describe`) and
 * `substrate/engines/types.ts` re-exports the status and account types for engine code.
 */
import type { CodingCliStatus } from "./coding-cli.ts";
import type { ProviderInfo } from "./providers.ts";
import type { ProviderUsage } from "./provider-usage.ts";

/** Where an engine stands (`EngineStatus.code`). Wire values: never rename one. */
export const EngineStatusCode = {
  Ready: "ready",
  NotInstalled: "not_installed",
  NotRunning: "not_running",
  NeedsLogin: "needs_login",
  Error: "error",
} as const;
export type EngineStatusCode = (typeof EngineStatusCode)[keyof typeof EngineStatusCode];

/** How an engine runs a build: the studio's own tool loop, or a delegated CLI's harness. */
export const EngineKind = {
  Direct: "direct",
  Delegated: "delegated",
} as const;
export type EngineKind = (typeof EngineKind)[keyof typeof EngineKind];

export interface EngineStatus {
  code: EngineStatusCode;
  detail: string;
  /** What the UI should offer to do about it. */
  remedy?: string;
}

/** Subscription engines only: which login Studio uses and the state of the external CLI. */
export interface EngineAccount {
  /** env: a variable decides; isolated: Studio's own login; system: the CLI's own login, as used in Terminal. */
  source: "env" | "isolated" | "system" | "none";
  /** The environment variable that decides the login when `source` is env. */
  variable?: string;
  /** What signing out of Studio's own login leaves: the Terminal login, or no connection. */
  afterSignOut: "terminal" | "signed-out";
  cli: { state: CodingCliStatus["state"]; version?: string; path?: string };
}

export interface EngineDescriptor {
  id: string;
  label: string;
  kind: EngineKind;
  supportsSessions?: boolean;
  /** Compacts a session in place with the provider's own compaction (Claude Code, Codex). */
  compactsNatively?: boolean;
  status: EngineStatus;
  usage?: ProviderUsage | null;
  catalog?: ModelCatalogStatus;
  account?: EngineAccount | null;
  /** The provider table's row for this engine (`shared/providers.ts`); null for an unlisted engine. */
  provider?: ProviderInfo | null;
  models: Array<{
    id: string;
    label: string;
    resolvedModel?: string;
    /** The model the provider's catalog names as its default; the picker lists it for "default". */
    providerDefault?: boolean;
    contextWindow: number;
    supportsFast?: boolean;
    supportsTools: boolean;
    supportsVision: boolean;
    stale?: boolean;
    /** A short alias the CLI resolves to another listed model, so pickers list that model once. */
    aliasOf?: string;
    note?: string;
    /** Runs at no cost and with no account (OpenCode's own free models). */
    free?: boolean;
    /** What the composer's effort menu offers for this model; empty = no effort dial. */
    efforts?: string[];
    defaultEffort?: string;
  }>;
  defaultModel: string | null;
}

/** Is the engine ready to take work? */
export function isEngineReady(engine: { status: Pick<EngineStatus, "code"> }): boolean {
  return engine.status.code === EngineStatusCode.Ready;
}

/** Does the engine wait for the user to sign in? */
export function needsSignIn(engine: { status: Pick<EngineStatus, "code"> }): boolean {
  return engine.status.code === EngineStatusCode.NeedsLogin;
}

/** Does the engine run builds through its own CLI's harness (a subscription)? */
export function isDelegatedEngine(engine: Pick<EngineDescriptor, "kind">): boolean {
  return engine.kind === EngineKind.Delegated;
}

/** Does the engine hold sessions of its own: a subscription's CLI, or Bonsai's local sessions? */
export function holdsSessions(engine: Pick<EngineDescriptor, "supportsSessions" | "kind">): boolean {
  return engine.supportsSessions ?? isDelegatedEngine(engine);
}

/**
 * Can a game chat on this engine give each job its own model? A session engine can, and so can a
 * completion-only local engine that offers a model with tools: its jobs run on its own models in
 * the classic loop, without pretending it holds sessions.
 */
export function splitsRoles(engine: Pick<EngineDescriptor, "supportsSessions" | "kind" | "models">): boolean {
  return holdsSessions(engine) || engine.models.some((model) => model.supportsTools);
}

/** Can a build run on this engine now: ready, and either delegated or offering a model with tools? */
export function canBuildWith(engine: Pick<EngineDescriptor, "status" | "kind" | "models">): boolean {
  if (!isEngineReady(engine)) return false;
  return isDelegatedEngine(engine) || engine.models.some((model) => model.supportsTools);
}

/** Which sign-in a subscription engine uses (`EngineAccount.source`). Shown in Settings: never rename a value. */
export const LoginSource = {
  /** An environment variable decides. */
  Env: "env",
  /** Studio's own login. */
  Isolated: "isolated",
  /** The CLI's own login, as used in Terminal. */
  System: "system",
  None: "none",
} as const satisfies Record<string, EngineAccount["source"]>;
export type LoginSource = (typeof LoginSource)[keyof typeof LoginSource];
