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
 * kept in the Keychain when the CLI reaches it and else in its own file in `~/.gemini`; the studio
 * reads neither.
 */
import { CatalogError } from "./model-catalog.ts";
import type { EngineModel } from "./types.ts";
import { ModelContextSource } from "./types.ts";
import { ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";
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
  const rows = byThinkingLevel(
    listed
      .map((entry) => record(entry))
      .filter((entry) => text(entry.modelId))
      .map((entry) => modelRow(text(entry.modelId), text(entry.name), text(entry.modelId) === current)),
  );
  const tier = record(record(record(body._meta).antigravity).tier);
  return {
    sessionId,
    models: rows,
    ...(text(tier.id) ? { tier: { id: text(tier.id), name: text(tier.name) || text(tier.id) } } : {}),
  };
}

/** How hard a model thinks, fastest first: the levels an id may end in (`gemini-3.8-flash-high`). */
const LEVELS: readonly string[] = Object.values(ReasoningEffort);
/** A name's closing bracket, where Antigravity says the level: "Gemini 3.8 Flash (High)". */
const NAME_LEVEL = /\s*\([^()]*\)\s*$/;

/** A listed id as a model and the level it thinks at, or null for an id that names no level. */
function leveled(id: string): { base: string; level: string } | null {
  const cut = id.lastIndexOf("-");
  const level = id.slice(cut + 1);
  return cut > 0 && LEVELS.includes(level) ? { base: id.slice(0, cut), level } : null;
}

/**
 * Antigravity lists each thinking level of a model as a model of its own (`gemini-3.8-flash-high`,
 * `-medium`, `-low`). A model listed at two levels or more becomes one row with an effort dial:
 * its id is the listed ids' common start, its name the listed name less the level, and it starts
 * at the level the session starts on, else the one Google lists first. A model listed at one
 * level stays as listed: there is nothing to dial.
 */
function byThinkingLevel(rows: EngineModel[]): EngineModel[] {
  const families = new Map<string, EngineModel[]>();
  for (const row of rows) {
    const base = leveled(row.id)?.base;
    if (base) families.set(base, [...(families.get(base) ?? []), row]);
  }
  const taken = new Set(rows.map((row) => row.id));
  const grouped = (row: EngineModel): EngineModel[] | undefined => {
    const base = leveled(row.id)?.base;
    const family = base ? families.get(base) : undefined;
    return base && family && family.length > 1 && !taken.has(base) ? family : undefined;
  };
  return rows.flatMap((row) => {
    const family = grouped(row);
    if (!family) return [row];
    return family[0] === row ? [familyRow(family)] : [];
  });
}

/** One row for a model's listed levels (`byThinkingLevel`). */
function familyRow(family: EngineModel[]): EngineModel {
  const [first] = family;
  if (!first) throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.Malformed());
  const level = (row: EngineModel) => leveled(row.id)?.level ?? "";
  const starts = family.find((row) => row.providerDefault) ?? first;
  const { providerDefault: _listed, ...row } = first;
  return {
    ...row,
    id: leveled(first.id)?.base ?? first.id,
    label: first.label.replace(NAME_LEVEL, "") || first.label,
    supportsThinking: true,
    efforts: family.map(level).sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b)),
    defaultEffort: level(starts),
    ...(family.some((member) => member.providerDefault) ? { providerDefault: true } : {}),
  };
}

/**
 * The id `session/set_model` takes for a picked model at an effort: a model with a dial
 * (`byThinkingLevel`) at the effort when it offers it, else at the level it starts at. Any other
 * id is the listed one already, a level's own id saved before the dial included.
 */
export function antigravityModelId(models: readonly EngineModel[], model: string, effort?: string): string {
  // Nothing listed yet (a loaded session need not list): an effort is only ever sent for a model
  // with a dial, so the pair names the level's id, unless the id is a level's own already.
  if (!models.length) return effort && !leveled(model) ? `${model}-${effort}` : model;
  const row = models.find((candidate) => candidate.id === model);
  if (!row?.efforts?.length) return model;
  const level = effort && row.efforts.includes(effort) ? effort : (row.defaultEffort ?? row.efforts[0]);
  return `${model}-${level}`;
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

/**
 * The titles of the notices the CLI writes as a turn's whole reply when Google refused the turn: it
 * then ends the turn as finished (`end_turn`) and says nothing more over the protocol (1.5.9: a
 * `PERMISSION_DENIED` with `VALIDATION_REQUIRED` reads "⚠ Verification Required"). The CLI's own
 * spelling: never rename a value.
 */
export const AntigravityNotice = {
  /** Google wants the account verified in a browser before it serves it. */
  VerificationRequired: "Verification Required",
} as const;
export type AntigravityNotice = (typeof AntigravityNotice)[keyof typeof AntigravityNotice];

/** The sign the CLI opens such a notice with. */
const NOTICE_SIGN = "⚠";
/** A notice is one short line; a reply longer than this is the model's own words. */
const NOTICE_MAX_CHARS = 80;

/**
 * The title of the CLI's notice when a reply is nothing but one, else null: one line, the warning
 * sign, then a title. A model's reply that only starts with the sign has more to it.
 */
export function antigravityNotice(reply: string): string | null {
  const line = reply.trim();
  if (!line.startsWith(NOTICE_SIGN) || line.includes("\n")) return null;
  const title = line.slice(NOTICE_SIGN.length).replace(/^️/, "").trim();
  return title && title.length <= NOTICE_MAX_CHARS ? title : null;
}

/** Where Google sends an account to be verified: its own sign-in host, over https. */
const VERIFY_HOST = "accounts.google.com";
/** The page Google names for the check, as the CLI's log writes Google's refusal. */
const VALIDATION_URL = /"validation_url"\s*:\s*"([^"]+)"/g;

/**
 * The page Google gave for verifying the account, from the CLI's log of the refused turn: the last
 * one it names, and only on Google's own sign-in host over https; null when there is none.
 */
export function verificationPage(log: string): string | null {
  let found: string | null = null;
  for (const [, raw = ""] of log.matchAll(VALIDATION_URL)) {
    const page = googleSignInPage(raw.replace(/\\u0026/g, "&"));
    if (page) found = page;
  }
  return found;
}

/** `address` when it is a page on Google's sign-in host over https, else null. */
export function googleSignInPage(address: string): string | null {
  try {
    const url = new URL(address);
    const ok = url.protocol === "https:" && url.hostname === VERIFY_HOST && !url.username && !url.password && !url.port;
    return ok ? url.toString() : null;
  } catch {
    return null;
  }
}
