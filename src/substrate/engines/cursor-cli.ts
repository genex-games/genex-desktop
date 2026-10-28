/**
 * What the studio reads from Cursor's CLI (`cursor-agent`) outside a session, and how a session is
 * started: the models the account can run (`cursor-agent models`), whether it is signed in
 * (`cursor-agent status --format json`), and the command line, variables and hosts of one turn.
 *
 * Cursor keeps its own sign-in, which the studio never reads. On a Mac the CLI keeps it in the
 * Keychain unless told otherwise, and no command in the studio's sandbox can reach the Keychain, so
 * every call the studio makes tells it to keep the sign-in in its file instead
 * (`AGENT_CLI_CREDENTIAL_STORE=file`, `credential-homes.ts`): a Terminal sign-in to the Keychain is
 * not Genex's, and Genex signs in on its own.
 */
import { CatalogError } from "./model-catalog.ts";
import type { EngineModel } from "./types.ts";
import { ModelContextSource } from "./types.ts";
import { ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { stripTerminalCodes } from "../../shared/terminal.ts";
import { t } from "../../shared/i18n.ts";

/** A model whose context the listing does not give (it gives none) is assumed to have this much. */
const DEFAULT_CONTEXT_TOKENS = 200_000;
/** A reply may use this many tokens: the listing names no output limit. */
const DEFAULT_REPLY_TOKENS = 32_000;
/** The line `cursor-agent models` heads its list with. */
const LIST_HEADING = "Available models";
/** What it prints instead of a list for an account that can run nothing. */
const NO_MODELS = "No models available for this account.";
/** The tip line under the list. */
const TIP = /^Tip:/;
/** One model's line: `id - Display Name (current, default)`, the name and the marks optional. */
const MODEL_LINE = /^(\S+)(?: - (.+?))?(?: \(((?:current|default)(?:, (?:current|default))?)\))?$/;
/** The mark on the model the account runs when none is named. */
const DEFAULT_MARK = "default";

/** The variable every call to the CLI carries: its sign-in in its file, never the Keychain. */
export const CURSOR_FILE_STORE = { AGENT_CLI_CREDENTIAL_STORE: "file" } as const;

/**
 * Two options `--help` does not list, which every call that starts the agent passes (checked on
 * 2026.10.22): the CLI never updates itself from Genex (its updater rewrites `~/.local/bin/agent`,
 * which Grok Build's installer also owns), and a turn ends when its reply does instead of waiting
 * for a dev server the agent left running in the background, which kept `--print` from exiting.
 */
const UNLISTED_OPTIONS = ["--disable-auto-update", "--single-turn"] as const;

/**
 * Where a session reaches Cursor: its API and agent servers (`api2`, `api3`, `repo42` and the rest
 * under `cursor.sh`, and `cursorapi.com`, the two its network guide names) and `cursor.com`, which
 * refreshes a sign-in.
 */
export const CURSOR_HOSTS = ["*.cursor.sh", "*.cursorapi.com", "cursor.com", "api.cursor.com"] as const;

/** What the CLI's sign-in commands are: in a terminal of their own, never in a session. */
export const CursorCommand = {
  SignIn: "login",
  SignOut: "logout",
  Status: "status",
  Models: "models",
} as const;
export type CursorCommand = (typeof CursorCommand)[keyof typeof CursorCommand];

/** What a model listing that cannot be read says in Settings, in the person's language. */
const MESSAGE = {
  Malformed: () => t("Cursor's model list could not be read."),
  StatusUnreadable: () => t("Cursor's sign-in status could not be read."),
} as const;

/**
 * The models `cursor-agent models` lists, as picker rows, in its order; the one it marks
 * `default` is the provider's default. An account with nothing to run is no list, not an error;
 * anything else that is no list is refused.
 */
export function parseCursorModels(stdout: string): EngineModel[] {
  const lines = stripTerminalCodes(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes(NO_MODELS)) return [];
  const start = lines.indexOf(LIST_HEADING);
  if (start < 0) throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.Malformed());
  const rows: EngineModel[] = [];
  for (const line of lines.slice(start + 1)) {
    if (TIP.test(line)) break;
    const match = MODEL_LINE.exec(line);
    if (!match?.[1]) continue;
    rows.push(cursorRow(match[1], match[2], (match[3] ?? "").split(", ").includes(DEFAULT_MARK)));
  }
  return rows;
}

/**
 * A listed model as a picker row. The listing gives no context, limits or capabilities: every
 * model Cursor's agent runs calls tools, and its read tool shows a picture to the model, so a
 * reviewer on Cursor sees the build's frames.
 */
function cursorRow(id: string, name: string | undefined, providerDefault: boolean): EngineModel {
  return {
    id,
    label: name?.trim() || id,
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    contextSource: ModelContextSource.Unknown,
    maxTokens: DEFAULT_REPLY_TOKENS,
    supportsTools: true,
    supportsVision: true,
    supportsThinking: false,
    ...(providerDefault ? { providerDefault: true } : {}),
  };
}

/** Whether `cursor-agent status --format json` says an account is signed in (its typed field, never its words). */
export function parseCursorStatus(stdout: string): { signedIn: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.StatusUnreadable());
  }
  const authenticated =
    value && typeof value === "object" ? (value as { isAuthenticated?: unknown }).isAuthenticated : undefined;
  if (typeof authenticated !== "boolean")
    throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.StatusUnreadable());
  return { signedIn: authenticated };
}

/**
 * What a session's tools may do. A build edits its folder; a read-only session (a playtester, a
 * reviewer, a lead while its build runs, a chat in Plan) runs from a scratch folder the studio's
 * sandbox lets it write, and only reads the game; a blind judge cannot read the game at all; an
 * answer (a judge's verdict) asks Cursor's own read-only mode for a reply.
 */
export const CursorAccess = {
  Build: "build",
  ReadOnly: "read-only",
  Blind: "blind",
  Answer: "answer",
} as const;
export type CursorAccess = (typeof CursorAccess)[keyof typeof CursorAccess];

/** Cursor's own mode for a reply with no edits (`--mode ask`). */
const ASK_MODE = "ask";
/** Cursor's own sandbox: off, since it cannot start inside the studio's, which holds the session. */
const OWN_SANDBOX_OFF = "disabled";

/**
 * One turn's command line: print mode with one JSON event per line and the reply's words as they
 * come, the workspace trusted (it never asks), every tool call allowed (the studio's sandbox is the
 * boundary), and the model and the session to continue when there are.
 */
export function cursorSessionArgv(input: {
  access: CursorAccess;
  workspace: string;
  model?: string | undefined;
  resume?: string | undefined;
}): string[] {
  const { access, workspace, model, resume } = input;
  return [
    ...UNLISTED_OPTIONS,
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--force",
    "--sandbox",
    OWN_SANDBOX_OFF,
    "--workspace",
    workspace,
    ...(access === CursorAccess.Answer ? ["--mode", ASK_MODE] : []),
    ...(model ? ["--model", model] : []),
    ...(resume ? ["--resume", resume] : []),
  ];
}
