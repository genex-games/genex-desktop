/**
 * The connector form: how Studio reaches the server, the names of its environment variables and
 * headers with their secret values, where it may be used, and which of its tools the agents may call.
 * A secret value is typed here and never read back.
 */
import type { JSX } from "react";
import type { McpToolSummary, McpTransport } from "../../../shared/mcp.ts";
import type { McpConnectorDraft } from "../../../shared/mcp-import.ts";
import { SecretStorageIssue } from "../../../shared/secret-storage.ts";
import { Button } from "../../ui/Button.tsx";
import { type Draft, splitNames, toolAllowed } from "./draft.ts";

const TRANSPORTS: McpTransport[] = ["stdio", "http", "sse"];
const MESSAGE = { AutoApprove: "Allow calls without asking, including changes this tool can make" } as const;

/** Why a typed secret value has nowhere to go, by the lock main reported. */
const SECRETS_LOCKED = {
  [SecretStorageIssue.OsCredentialsDisabled]: "Secrets cannot be stored in this profile: OS credential access is off.",
  [SecretStorageIssue.EncryptionUnavailable]:
    "Secrets cannot be stored in this profile: Studio has no OS encryption here.",
  [SecretStorageIssue.NoKeyring]:
    "Secrets cannot be stored: no unlocked system keyring is available. Start GNOME Keyring or KWallet and unlock it, then restart Genex.",
} as const satisfies Record<SecretStorageIssue, string>;

/** A labelled field of the form. */
export function Label({ text, children }: { text: string; children: JSX.Element }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-ink-3">{text}</span>
      {children}
    </label>
  );
}

function Text({
  value,
  onChange,
  placeholder,
  disabled,
  password,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  password?: boolean;
  ariaLabel: string;
}): JSX.Element {
  return (
    <input
      type={password ? "password" : "text"}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 min-w-0 rounded-sm bg-soft px-3 text-sm text-ink outline-none placeholder:text-ink-3 disabled:opacity-50"
    />
  );
}

/** Change the form's state; the connector's own fields go through `patch`. */
type Update = (change: (draft: Draft) => Draft) => void;

/** What the form edits and how. */
export interface FormProps {
  draft: Draft;
  update: Update;
  patch: (change: Partial<McpConnectorDraft>) => void;
}

/** A stdio server's command, its argv one entry per row, and its working directory. */
function StdioFields({ draft, update, patch }: FormProps): JSX.Element {
  const setArgs = (args: (current: string[]) => string[]): void => update((d) => ({ ...d, args: args(d.args) }));
  return (
    <>
      <Label text="Command">
        <Text ariaLabel="Command" value={draft.connector.command ?? ""} onChange={(next) => patch({ command: next })} />
      </Label>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-micro text-ink-3">Arguments — one per row; no shell quoting</legend>
        {draft.args.map((arg, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: an argument is its position; equal arguments are allowed
          <div className="flex gap-2" key={index}>
            <Text
              ariaLabel={`Argument ${index + 1}`}
              value={arg}
              onChange={(next) => setArgs((args) => args.map((v, i) => (i === index ? next : v)))}
            />
            <Button
              aria-label={`Remove argument ${index + 1}`}
              onClick={() => setArgs((args) => args.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button onClick={() => setArgs((args) => [...args, ""])}>Add argument</Button>
      </fieldset>
      <Label text="Working directory (absolute, optional)">
        <Text
          ariaLabel="Working directory"
          value={draft.connector.cwd ?? ""}
          onChange={(next) => patch({ cwd: next })}
        />
      </Label>
    </>
  );
}

/** One named secret: its value, typed and never shown back, and Clear when one is stored. */
function SecretRow({
  kind,
  name,
  props,
  stored,
  secretsAvailable,
}: {
  kind: "env" | "header";
  name: string;
  props: FormProps;
  stored: Set<string>;
  secretsAvailable: boolean;
}): JSX.Element {
  const key = `${kind}.${name}`;
  const setSecret = (value: string): void => props.update((d) => ({ ...d, secrets: { ...d.secrets, [key]: value } }));
  return (
    <div className="flex items-center gap-2">
      <span className="w-44 shrink-0 truncate font-mono text-micro text-ink-2">{name}</span>
      <Text
        ariaLabel={`Value for ${name}`}
        password
        value={props.draft.secrets[key] ?? ""}
        placeholder={stored.has(key) ? "stored — type to replace" : "value (stored encrypted)"}
        disabled={!secretsAvailable}
        onChange={setSecret}
      />
      {stored.has(key) && (
        <Button aria-label={`Clear the stored value for ${name}`} onClick={() => setSecret("")}>
          Clear
        </Button>
      )}
    </div>
  );
}

/** A remote server's sign-in and header names. */
function RemoteFields({ draft, update, patch }: FormProps): JSX.Element {
  return (
    <>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={draft.connector.authentication === "oauth"}
          onChange={(event) => patch({ authentication: event.target.checked ? "oauth" : undefined })}
        />
        Sign in through a browser (OAuth). Connect may ask to unlock saved credentials.
      </label>
      <Label text="Header names">
        <Text
          ariaLabel="Header names"
          value={draft.headerText}
          onChange={(next) => update((d) => ({ ...d, headerText: next }))}
        />
      </Label>
    </>
  );
}

function ScopeFields({ draft, patch, project }: FormProps & { project: string | null | undefined }): JSX.Element {
  const name = `scope-${draft.connector.id || "new"}`;
  return (
    <fieldset className="flex flex-wrap items-center gap-3">
      <legend className="text-micro text-ink-3">Where it may be used</legend>
      <label className="flex items-center gap-1 text-xs">
        <input
          type="radio"
          name={name}
          checked={draft.connector.scope === "global"}
          onChange={() => patch({ scope: "global" })}
        />
        every project
      </label>
      <label className="flex items-center gap-1 text-xs">
        <input
          type="radio"
          name={name}
          disabled={!project}
          checked={draft.connector.scope !== "global"}
          onChange={() => project && patch({ scope: { projects: [project] } })}
        />
        this project only
      </label>
    </fieldset>
  );
}

function ToolChecklist({
  tools,
  draft,
  onToolAllowed,
  onToolAutoApproved,
}: {
  tools: McpToolSummary[];
  draft: Draft;
  onToolAllowed: (name: string, allowed: boolean) => void;
  onToolAutoApproved: (name: string, approved: boolean) => void;
}): JSX.Element | null {
  if (!tools.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-micro text-ink-3">Tools the agents may call</span>
      {tools.map((tool) => (
        <div key={tool.name} className="flex flex-col gap-1 text-xs">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={toolAllowed(draft.connector.toolPolicy, tool.name)}
              onChange={(event) => onToolAllowed(tool.name, event.target.checked)}
            />
            <span className="font-mono text-micro">{tool.name}</span>
            <span className="min-w-0 flex-1 truncate text-ink-3">{tool.description}</span>
          </label>
          <label className="flex items-center gap-2 pl-5 text-micro text-ink-3">
            <input
              type="checkbox"
              aria-label={`Allow ${tool.name} without asking`}
              disabled={!toolAllowed(draft.connector.toolPolicy, tool.name)}
              checked={draft.connector.toolPolicy.autoApprove?.includes(tool.name) === true}
              onChange={(event) => onToolAutoApproved(tool.name, event.target.checked)}
            />
            {MESSAGE.AutoApprove}
          </label>
        </div>
      ))}
    </div>
  );
}

function TransportChoice({ draft, patch }: FormProps): JSX.Element {
  return (
    <fieldset className="flex flex-wrap items-center gap-3">
      <legend className="text-micro text-ink-3">How Studio reaches it</legend>
      {TRANSPORTS.map((transport) => (
        <label key={transport} className="flex items-center gap-1 text-xs">
          <input
            type="radio"
            name={`transport-${draft.connector.id || "new"}`}
            checked={draft.connector.transport === transport}
            onChange={() => patch({ transport })}
          />
          {transport}
        </label>
      ))}
    </fieldset>
  );
}

/** The whole form, with Save and connect and Cancel. */
export function ConnectorForm({
  props,
  project,
  tools,
  stored,
  secretsAvailable,
  secretsLocked = SecretStorageIssue.EncryptionUnavailable,
  error,
  busy,
  onToolAllowed,
  onToolAutoApproved,
  onSave,
  onCancel,
}: {
  props: FormProps;
  project: string | null | undefined;
  tools: McpToolSummary[];
  stored: Set<string>;
  secretsAvailable: boolean;
  /** Why `secretsAvailable` is false; without one the form names missing OS encryption. */
  secretsLocked?: SecretStorageIssue;
  error: string;
  busy: boolean;
  onToolAllowed: (name: string, allowed: boolean) => void;
  onToolAutoApproved: (name: string, approved: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { draft, update, patch } = props;
  const stdio = draft.connector.transport === "stdio";
  const secret = (kind: "env" | "header") => (name: string) => (
    <SecretRow
      key={`${kind}.${name}`}
      kind={kind}
      name={name}
      props={props}
      stored={stored}
      secretsAvailable={secretsAvailable}
    />
  );
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-line pt-2">
      <div className="flex flex-wrap gap-2">
        <Label text="Id">
          <Text
            ariaLabel="Connector id"
            value={draft.connector.id}
            disabled={!draft.isNew}
            onChange={(next) => patch({ id: next })}
          />
        </Label>
        <Label text="Name">
          <Text ariaLabel="Connector name" value={draft.connector.name} onChange={(next) => patch({ name: next })} />
        </Label>
      </div>
      <TransportChoice {...props} />
      {stdio ? (
        <StdioFields {...props} />
      ) : (
        <Label text="Address">
          <Text
            ariaLabel="Address"
            placeholder="https://…"
            value={draft.connector.url ?? ""}
            onChange={(next) => patch({ url: next })}
          />
        </Label>
      )}
      <Label text="Environment variable names">
        <Text
          ariaLabel="Environment variable names"
          value={draft.envText}
          onChange={(next) => update((d) => ({ ...d, envText: next }))}
        />
      </Label>
      {!stdio && <RemoteFields {...props} />}
      {!secretsAvailable && <p className="text-micro text-orange">{SECRETS_LOCKED[secretsLocked]}</p>}
      {splitNames(draft.envText).map(secret("env"))}
      {!stdio && splitNames(draft.headerText).map(secret("header"))}
      <ScopeFields {...props} project={project} />
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={draft.connector.shareProjectRoot === true}
          onChange={(event) => patch({ shareProjectRoot: event.target.checked })}
        />
        Share the current project's folder path with this server (MCP roots)
      </label>
      <ToolChecklist
        tools={tools}
        draft={draft}
        onToolAllowed={onToolAllowed}
        onToolAutoApproved={onToolAutoApproved}
      />
      {error && (
        <p role="alert" className="extensions-error">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button variant="default" disabled={busy || !draft.connector.id} onClick={onSave}>
          {busy ? "Connecting…" : "Save and connect"}
        </Button>
        <Button aria-label="Cancel the connector form" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
