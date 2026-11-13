/**
 * What the studio reads from Google's Antigravity CLI (`agy`) and how a session is started.
 *
 * Antigravity runs on the person's own Google sign-in and Google AI plan. Its documented way into
 * another application is `agy acp`, an Agent Client Protocol server on stdio (`acp.ts`), which is
 * the only mode the studio starts: Google's own words are that wrapping its print mode (`agy -p`)
 * is not for consumer plans, while any ACP client may launch `agy acp`.
 *
 * The CLI has no command that says whether it is signed in. A new session does: it answers with
 * the models the account can run and its plan, or refuses with ACP's sign-in code
 * (`AcpErrorCode.AuthRequired`). The sign-in itself is the CLI's: `agy acp --login` in a terminal,
 * kept in the operating system's own store (the Keychain on a Mac), which the studio never reads.
 */
import { CatalogError } from "./model-catalog.ts";
import type { EngineModel } from "./types.ts";
import { ModelContextSource } from "./types.ts";
import { ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { t } from "../../shared/i18n.ts";

/** A model whose context the session does not give (it gives none) is assumed to have this much. */
const DEFAULT_CONTEXT_TOKENS = 200_000;
/** A reply may use this many tokens: the session names no output limit. */
const DEFAULT_REPLY_TOKENS = 32_000;

/** The CLI's commands the studio runs. Its own spelling: never rename a value. */
export const AntigravityCommand = {
  /** The ACP server on stdio. */
  Acp: "acp",
  Update: "update",
} as const;
export type AntigravityCommand = (typeof AntigravityCommand)[keyof typeof AntigravityCommand];

/** `agy acp --login`: sign in with Google in the terminal it runs in, then exit. */
export const ANTIGRAVITY_LOGIN_ARGV = [AntigravityCommand.Acp, "--login"] as const;

/** One session's command line: the ACP server alone; the session's folder, model and prompt go over the protocol. */
export const ANTIGRAVITY_SESSION_ARGV = [AntigravityCommand.Acp] as const;

/**
 * Where a session reaches Google: its model and account servers (`*.googleapis.com`, which holds
 * the CLI's own endpoint and the sign-in's token refresh), the sign-in page's hosts and
 * Antigravity's own site.
 */
export const ANTIGRAVITY_HOSTS = ["*.googleapis.com", "accounts.google.com", "antigravity.google"] as const;

/** Who the studio says it is in `initialize`. */
export const ANTIGRAVITY_CLIENT = { name: "genex", title: "Genex" } as const;

/**
 * What a session's tools may do. A build edits its folder; a read-only session (a reviewer, a
 * lead while its build runs, a chat in Plan) runs from a scratch folder the studio's sandbox lets
 * it write, and only reads the game; an answer (a judge's verdict) is a reply from an empty folder.
 */
export const AntigravityAccess = {
  Build: "build",
  ReadOnly: "read-only",
  Answer: "answer",
} as const;
export type AntigravityAccess = (typeof AntigravityAccess)[keyof typeof AntigravityAccess];

/** The plan the signed-in account is on, as a session reports it (`_meta.antigravity.tier`). */
export interface AntigravityTier {
  id: string;
  name: string;
}

/** What a new or loaded session says about itself. */
export interface AntigravitySession {
  sessionId: string;
  models: EngineModel[];
  tier?: AntigravityTier;
}

const MESSAGE = {
  Malformed: () => t("Antigravity's model list could not be read."),
} as const;

/** One JSON object of the protocol. */
export type Json = Record<string, unknown>;

/** A value as a JSON object: anything else reads as an empty one. */
export const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

/** A value as text: anything else reads as none. */
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The answer to `session/new` or `session/load`: the session's id, the models the account can run
 * (`models.availableModels`, the ids `session/set_model` takes; the one the session starts on is
 * the provider's default) and the account's plan. A loaded session's answer need not repeat its id
 * (ACP's `session/load` answer carries none), so the id it was loaded by stands in; an answer with
 * no session id at all is refused.
 */
export function parseAntigravitySession(result: unknown, loaded = ""): AntigravitySession {
  const body = record(result);
  const sessionId = text(body.sessionId) || loaded;
  if (!sessionId) throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.Malformed());
  const models = record(body.models);
  const current = text(models.currentModelId);
  const listed = Array.isArray(models.availableModels) ? models.availableModels : [];
  const rows = listed
    .map((entry) => record(entry))
    .filter((entry) => text(entry.modelId))
    .map((entry) => modelRow(text(entry.modelId), text(entry.name), text(entry.modelId) === current));
  const tier = record(record(record(body._meta).antigravity).tier);
  return {
    sessionId,
    models: rows,
    ...(text(tier.id) ? { tier: { id: text(tier.id), name: text(tier.name) || text(tier.id) } } : {}),
  };
}

/**
 * A listed model as a picker row. The session gives no context, limits or capabilities: every
 * model Antigravity's agent runs calls tools, and the agent takes pictures in its prompt.
 */
function modelRow(id: string, name: string, providerDefault: boolean): EngineModel {
  return {
    id,
    label: name.trim() || id,
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    contextSource: ModelContextSource.Unknown,
    maxTokens: DEFAULT_REPLY_TOKENS,
    supportsTools: true,
    supportsVision: true,
    supportsThinking: false,
    ...(providerDefault ? { providerDefault: true } : {}),
  };
}
