/**
 * The model providers the app knows, in one table: the name a person says, the sign-in words and
 * install link for a subscription, how its sign-in runs, and what kind of roles it takes.
 * `EngineRegistry.describe` serves the row on each `EngineDescriptor` (`provider`), main and the
 * renderer take `SUBSCRIPTION_ENGINES` from here, and the harness seed's role tables are held to
 * it by `tests/conformance/providers.test.ts`. Adding a provider starts here
 * (docs/agent/recipes.md, "Provider or engine").
 */

/**
 * How a provider signs in: Claude through a piped or embedded terminal plus status polling, Codex
 * through its native login reported from the in-app console, OpenCode through its own `auth login`
 * in the embedded terminal (which keeps every provider it signs in to), `none` for an engine with
 * no sign-in of its own (a local model, or OpenRouter, whose key is pasted in Settings).
 */
export type LoginKind = "terminal" | "console" | "cli" | "none";

/**
 * Who pays for a provider's work: nobody (`local`), a plan the person already has
 * (`subscription`, throttled server-side, never billed per call), or per token (`metered`). A
 * choice the app makes on its own — a fallback, a first ready engine — never lands on a metered
 * provider: only the person's explicit pick spends their credits.
 */
export type Billing = "local" | "subscription" | "metered";

/**
 * Which roles a provider can run: `presets` has the model rows and single-pick presets of
 * `shared/model-roles.ts`, `sessions` can cross roles without presets, `completion` gives each
 * job its own model without sessions (its reviewers may join a session run, its main agent may
 * hand its jobs to one), and `single` runs one model.
 */
export type RoleSupport = "presets" | "sessions" | "completion" | "single";

/** What the sign-in card and the Models room say for a subscription. */
export interface SignInCopy {
  /** "your Claude subscription": the thing the user already pays for. */
  readonly product: string;
  readonly card: string;
  readonly account: string;
  readonly install: string;
  /** The vendor's own install page for the CLI. */
  readonly installUrl: string;
  readonly get: string;
  readonly who: string;
}

export interface ProviderInfo {
  /** The engine id (`Engine.id`). */
  readonly id: string;
  /** The provider's name as a person says it. */
  readonly label: string;
  readonly subscription: boolean;
  readonly login: LoginKind;
  readonly roles: RoleSupport;
  readonly billing: Billing;
  /** Subscriptions only. */
  readonly signIn: SignInCopy | null;
}

/** The id of every engine the app knows (`Engine.id`). Persisted in settings and logs: never rename a value. */
export const EngineId = {
  ClaudeCode: "claude-code",
  Codex: "codex",
  Bonsai: "bonsai",
  Ollama: "ollama",
  OpenCode: "opencode",
  OpenRouter: "openrouter",
} as const;
export type EngineId = (typeof EngineId)[keyof typeof EngineId];

/** Every provider, subscriptions first in preference order. */
export const PROVIDERS = [
  {
    id: EngineId.ClaudeCode,
    label: "Claude Code",
    subscription: true,
    login: "terminal",
    roles: "presets",
    billing: "subscription",
    signIn: {
      product: "your Claude subscription",
      card: "Use your Claude subscription",
      account: "Claude account",
      install: "Claude Code isn't installed on this Mac.",
      installUrl: "https://code.claude.com",
      get: "Install Claude Code",
      who: "Claude Code handles that part",
    },
  },
  {
    id: EngineId.Codex,
    label: "Codex",
    subscription: true,
    login: "console",
    roles: "presets",
    billing: "subscription",
    signIn: {
      product: "your ChatGPT subscription",
      card: "Use your ChatGPT subscription",
      account: "ChatGPT account",
      install: "Codex isn't installed on this Mac.",
      installUrl: "https://developers.openai.com/codex/cli",
      get: "Install Codex",
      who: "Codex handles that part",
    },
  },
  {
    id: EngineId.Bonsai,
    label: "Bonsai",
    subscription: false,
    login: "none",
    roles: "sessions",
    billing: "local",
    signIn: null,
  },
  {
    id: EngineId.Ollama,
    label: "Ollama",
    subscription: false,
    login: "none",
    roles: "completion",
    billing: "local",
    signIn: null,
  },
  {
    id: EngineId.OpenCode,
    label: "OpenCode",
    subscription: false,
    login: "cli",
    roles: "sessions",
    billing: "metered",
    signIn: null,
  },
  {
    id: EngineId.OpenRouter,
    label: "OpenRouter",
    subscription: false,
    login: "none",
    roles: "sessions",
    billing: "metered",
    signIn: null,
  },
] as const satisfies readonly ProviderInfo[];

type Provider = (typeof PROVIDERS)[number];
export type ProviderId = Provider["id"];
type Subscription = Extract<Provider, { subscription: true }>;
export type SubscriptionId = Subscription["id"];

const isSubscription = (provider: Provider): provider is Subscription => provider.subscription;

/** The subscription engines, in preference order — "your subscription, through their harness". */
export const SUBSCRIPTION_ENGINES: readonly SubscriptionId[] = PROVIDERS.filter(isSubscription).map(
  (provider) => provider.id,
);

/** The table row for an engine id, or undefined for an engine the table does not list. */
export function providerInfo(id: string | null | undefined): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** How this engine signs in; `none` for a local engine or one the table does not list. */
export function loginKind(id: string | null | undefined): LoginKind {
  return providerInfo(id)?.login ?? "none";
}

/** True for a provider billed per token: the app never picks one on the person's behalf. */
export function isMetered(id: string | null | undefined): boolean {
  return providerInfo(id)?.billing === "metered";
}

/** True for a model this Mac runs itself: free, and never rate limited by anyone else. */
export function isLocalEngine(id: string | null | undefined): boolean {
  return providerInfo(id)?.billing === "local";
}
