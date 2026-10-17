/** A connector being added or edited, and the pure rules that turn it into what the host saves. */
import { joinCommandLine, splitCommandLine } from "../../../shared/command-line.ts";
import { MCP_ENV_NAME, MCP_HEADER_NAME, MCP_ID, type McpConnectorView, McpTransport } from "../../../shared/mcp.ts";
import { connectorSlug, type McpConnectorDraft, type McpDraft } from "../../../shared/mcp-import.ts";

/** The longest connector id `MCP_ID` allows. */
const MAX_ID_CHARS = 32;
/** The id of a server whose name has no letters or digits to make one from. */
const FALLBACK_ID = "server";
/** The header a key-based server signs in with, in place of the browser. */
const AUTHORIZATION = "authorization";

/** One secret: an environment variable on this Mac, or a header for a URL; "" keeps a stored value. */
export interface SecretRow {
  name: string;
  value: string;
}

/** The form's state: the connector, its command as typed, and its secrets as rows. */
export interface Draft {
  connector: McpConnectorDraft;
  createdAt?: string;
  /** A new connector takes its id from its name; a saved one keeps it — its tools are named after it. */
  isNew: boolean;
  /** A server on this Mac: its program and arguments as one line, quoted the way Terminal reads it. */
  commandLine: string;
  /** Environment variables (this Mac) or headers (a URL), with the value typed this session. */
  secretRows: SecretRow[];
}

/** What keeps the form from connecting yet. */
export const DraftProblem = {
  NoName: "no-name",
  NoCommand: "no-command",
  UnfinishedCommand: "unfinished-command",
  NoUrl: "no-url",
  BadSecretName: "bad-secret-name",
} as const;
export type DraftProblem = (typeof DraftProblem)[keyof typeof DraftProblem];

/** An empty connector: a global, enabled server on this Mac with no tools filtered. */
export const blankDraft = (): Draft => ({
  connector: { id: "", name: "", transport: McpTransport.Stdio, enabled: true, scope: "global", toolPolicy: {} },
  isNew: true,
  commandLine: "",
  secretRows: [],
});

/** Whether a connector runs on this Mac rather than at a URL. */
export const isLocal = (connector: McpConnectorDraft): boolean => connector.transport === McpTransport.Stdio;

/** The names a connector declares for its secrets on its side: variables on this Mac, headers for a URL. */
const secretNamesOf = (connector: McpConnectorDraft): string[] =>
  (isLocal(connector) ? connector.env : connector.headers) ?? [];

/**
 * The draft moved to `transport`. A move between this Mac and a URL leaves the secret rows behind:
 * a variable typed for a program here is never sent as a header to a URL (nor a header the other
 * way). HTTP and SSE are the same place, so their headers stay.
 */
export function withTransport(draft: Draft, transport: McpTransport): Draft {
  const connector = { ...draft.connector, transport };
  const moved = isLocal(connector) !== isLocal(draft.connector);
  return { ...draft, connector, secretRows: moved ? [] : draft.secretRows };
}

/** The command line a connector's program and arguments read as. */
const commandLineOf = (connector: McpConnectorDraft): string =>
  connector.command ? joinCommandLine([connector.command, ...(connector.args ?? [])]) : "";

/** A new connector's id: its name in id characters, numbered past the ids already taken. */
export function connectorIdFor(name: string, taken: ReadonlySet<string>): string {
  const slug = connectorSlug(name);
  const base = MCP_ID.test(slug) ? slug : connectorSlug(`${FALLBACK_ID}-${slug}`);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, MAX_ID_CHARS - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** A saved connector opened for editing; its launch approval and its source stay with the host. */
export const draftFrom = (view: McpConnectorView): Draft => {
  const { createdAt, trustedLaunch: _trust, source: _source, ...rest } = view.connector;
  return {
    connector: rest,
    createdAt,
    isNew: false,
    commandLine: commandLineOf(rest),
    secretRows: secretNamesOf(rest).map((name) => ({ name, value: "" })),
  };
};

/** A connector read from a paste, filling the form with its values. */
export const draftFromImport = (imported: McpDraft): Draft => {
  const kind = isLocal(imported.connector) ? "env" : "header";
  return {
    connector: imported.connector,
    isNew: true,
    commandLine: commandLineOf(imported.connector),
    secretRows: secretNamesOf(imported.connector).map((name) => ({
      name,
      value: imported.secrets[`${kind}.${name}`] ?? "",
    })),
  };
};

/** The rows that name something, trimmed, each name once. */
function namedRows(rows: readonly SecretRow[]): SecretRow[] {
  const seen = new Set<string>();
  return rows
    .map((row) => ({ ...row, name: row.name.trim() }))
    .filter((row) => row.name && !seen.has(row.name) && seen.add(row.name));
}

/** Whether a row's name is one the host can pass: a variable's for this Mac, a header's for a URL. */
const validSecretName = (connector: McpConnectorDraft, name: string): boolean =>
  (isLocal(connector) ? MCP_ENV_NAME : MCP_HEADER_NAME).test(name);

/** What the form still needs before it can connect, or null when it is ready. */
export function draftProblem(draft: Draft): DraftProblem | null {
  const { connector } = draft;
  if (!connector.name.trim()) return DraftProblem.NoName;
  if (isLocal(connector)) {
    if (!draft.commandLine.trim()) return DraftProblem.NoCommand;
    if (!splitCommandLine(draft.commandLine).ok) return DraftProblem.UnfinishedCommand;
  } else if (!connector.url?.trim()) return DraftProblem.NoUrl;
  const bad = namedRows(draft.secretRows).some((row) => !validSecretName(connector, row.name));
  return bad ? DraftProblem.BadSecretName : null;
}

/** A server on this Mac: its program and arguments from the command line; no address or sign-in. */
function keepLocalLaunch(connector: McpConnectorDraft, commandLine: string, names: string[]): void {
  const split = splitCommandLine(commandLine);
  const [command, ...args] = split.ok ? split.words : [];
  connector.command = command ?? "";
  if (args.length) connector.args = args;
  else delete connector.args;
  if (names.length) connector.env = names;
  else delete connector.env;
  delete connector.url;
  delete connector.headers;
  delete connector.authentication;
}

/**
 * A server at a URL: its address and header names. Browser sign-in stays as it was (the host turns
 * it on when the server asks); a key header is its own sign-in, so it turns browser sign-in off.
 */
function keepRemoteLaunch(connector: McpConnectorDraft, names: string[]): void {
  connector.url = connector.url?.trim() ?? "";
  if (names.length) connector.headers = names;
  else delete connector.headers;
  if (names.some((name) => name.toLowerCase() === AUTHORIZATION)) delete connector.authentication;
  delete connector.command;
  delete connector.args;
  delete connector.cwd;
}

/** The connector as the host saves it: an id, its own side's fields, and its secrets' names. */
export function connectorToSave(draft: Draft, taken: ReadonlySet<string>): McpConnectorDraft & { createdAt?: string } {
  const connector: McpConnectorDraft & { createdAt?: string } = { ...draft.connector };
  connector.name = connector.name.trim();
  if (draft.isNew) connector.id = connectorIdFor(connector.name, taken);
  if (draft.createdAt) connector.createdAt = draft.createdAt;
  const names = namedRows(draft.secretRows).map((row) => row.name);
  if (isLocal(connector)) keepLocalLaunch(connector, draft.commandLine, names);
  else keepRemoteLaunch(connector, names);
  return connector;
}

/** The values typed this session, keyed as the host stores them (`env.NAME` / `header.NAME`). */
export function secretsToSave(draft: Draft): Record<string, string> {
  const kind = isLocal(draft.connector) ? "env" : "header";
  const secrets: Record<string, string> = {};
  for (const row of namedRows(draft.secretRows)) if (row.value) secrets[`${kind}.${row.name}`] = row.value;
  return secrets;
}

type ToolPolicy = NonNullable<McpConnectorDraft["toolPolicy"]>;

/** A tool the server offers, switched on or off for the agents. Deny wins, so deny is what moves. */
export function withToolAllowed(policy: ToolPolicy | undefined, raw: string, allowed: boolean): ToolPolicy {
  const current = policy ?? {};
  const deny = new Set(current.deny ?? []);
  if (allowed) deny.delete(raw);
  else deny.add(raw);
  const next: ToolPolicy = {};
  const approved = (current.autoApprove ?? []).filter((name) => allowed || name !== raw);
  if (approved.length) next.autoApprove = approved;
  if (current.allow?.length) {
    next.allow = allowed ? [...new Set([...current.allow, raw])] : current.allow.filter((name) => name !== raw);
  }
  if (deny.size) next.deny = [...deny];
  return next;
}

/** A user-chosen exact tool grant, independent of the server's description or annotations. */
export function withToolAutoApproved(policy: ToolPolicy | undefined, raw: string, approved: boolean): ToolPolicy {
  const names = new Set(policy?.autoApprove ?? []);
  if (approved) names.add(raw);
  else names.delete(raw);
  return { ...policy, autoApprove: [...names] };
}

/** Whether the agents may call a tool: not denied, and allowed when an allow-list exists. */
export function toolAllowed(policy: ToolPolicy | undefined, name: string): boolean {
  const denied = (policy?.deny ?? []).includes(name);
  const allow = policy?.allow;
  return !denied && (!allow?.length || allow.includes(name));
}
