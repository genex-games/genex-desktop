/**
 * The Add MCP server window: paste what a server's install page gives you to fill it in, or say
 * where the server runs (this Mac or a URL) and type its name and command or address. Secrets are
 * name and value rows whose values are typed here and never read back; where it may be used and
 * what it may see sit under More options; a saved server's tool list joins them when editing.
 */
import type { ClipboardEvent, FormEvent, JSX, KeyboardEvent } from "react";
import { useState } from "react";
import type { McpToolSummary } from "../../../shared/mcp.ts";
import { McpTransport } from "../../../shared/mcp.ts";
import type { McpConnectorDraft, McpDraft } from "../../../shared/mcp-import.ts";
import { SecretStorageIssue } from "../../../shared/secret-storage.ts";
import { Button } from "../../ui/Button.tsx";
import { Checkbox } from "../../ui/Checkbox.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { Icon } from "../../ui/icons.tsx";
import { ViewSwitcher } from "../../ui/view-switcher.tsx";
import {
  connectorIdFor,
  type Draft,
  DraftProblem,
  draftProblem,
  isLocal,
  type SecretRow,
  toolAllowed,
  withTransport,
} from "./draft.ts";

/** Where a server runs, as the window's switch names it. */
const ServerPlace = { Mac: "mac", Url: "url" } as const;
type ServerPlace = (typeof ServerPlace)[keyof typeof ServerPlace];

const MESSAGE = {
  addTitle: "Add MCP server",
  editTitle: (name: string) => `Edit ${name}`,
  intro: "Its tools become available to the agents in your games.",
  paste: "Paste the JSON, command or URL from the server's install page to fill this in.",
  pasteLabel: "Paste a server configuration",
  pasted: "Filled in from your paste",
  clearPaste: "Clear",
  choose: (count: number) => `This paste has ${count} servers. Pick one:`,
  alsoPasted: "Also in this paste:",
  place: "Where the server runs",
  places: { [ServerPlace.Mac]: "On this Mac", [ServerPlace.Url]: "From a URL" },
  name: "Name",
  command: "Command",
  commandHint: "The line you would type in Terminal.",
  url: "URL",
  urlHint: "If the server needs an account, you'll sign in in your browser.",
  secrets: { env: "Environment variables", header: "Headers" },
  addSecret: { env: "Add environment variable", header: "Add header" },
  secretName: { env: "NAME", header: "Header" },
  secretValue: "Value",
  secretStored: "Stored · type to replace",
  removeSecret: (name: string) => `Remove ${name || "this row"}`,
  more: "More options",
  onlyHere: "Only in this game",
  onlyHereHint: "Otherwise every game can use it.",
  seeFolder: "Let it see this game's folder",
  startIn: "Start in folder",
  startInHint: "A full path, such as /Users/you/server.",
  toolPrefix: (id: string) => `Agents see its tools as ${id}__…`,
  tools: "Tools the agents may call",
  autoApprove: "Allow calls without asking, including changes this tool can make",
  connect: "Connect",
  save: "Save",
  connecting: "Connecting…",
  cancel: "Cancel",
  unfinishedCommand: "A quote in the command is never closed.",
  badSecretName: "Variable names use capital letters, digits and _; header names letters, digits and -.",
} as const;

/** Why a typed secret value has nowhere to go, by the lock main reported. */
const SECRETS_LOCKED = {
  [SecretStorageIssue.OsCredentialsDisabled]: "Secrets cannot be stored in this profile: OS credential access is off.",
  [SecretStorageIssue.EncryptionUnavailable]:
    "Secrets cannot be stored in this profile: Studio has no OS encryption here.",
  [SecretStorageIssue.NoKeyring]:
    "Secrets cannot be stored: no unlocked system keyring is available. Start GNOME Keyring or KWallet and unlock it, then restart Genex.",
} as const satisfies Record<SecretStorageIssue, string>;

/** Change the form's state; the connector's own fields go through `patch`. */
type Update = (change: (draft: Draft) => Draft) => void;

/** What the form edits and how. */
export interface FormProps {
  draft: Draft;
  update: Update;
  patch: (change: Partial<McpConnectorDraft>) => void;
}

/** A labelled text field of the window. */
function Field({
  label,
  value,
  onChange,
  hint,
  placeholder,
  mono = false,
  invalid = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
}): JSX.Element {
  return (
    <label className="connector-field">
      {label}
      <input
        aria-label={label}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        className={mono ? "font-mono" : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <span className={invalid ? "text-red" : "connector-hint"}>{hint}</span>}
    </label>
  );
}

/** The paste box: a paste (or Enter) reads it; what could not be read stays, with why. */
function PasteBox({ warnings, onRead }: { warnings: string[]; onRead: (text: string) => void }): JSX.Element {
  const [text, setText] = useState("");
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = event.clipboardData.getData("text");
    if (!pasted.trim()) return;
    event.preventDefault();
    setText(pasted);
    onRead(pasted);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    onRead(text);
  };
  return (
    <div className="connector-paste">
      <textarea
        aria-label={MESSAGE.pasteLabel}
        placeholder={MESSAGE.paste}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
      />
      {warnings.map((warning) => (
        <p key={warning} className="text-orange">
          {warning}
        </p>
      ))}
    </div>
  );
}

/** What a paste filled in, with a way back to an empty form, and what to check. */
function PastedNote({ warnings, onClear }: { warnings: string[]; onClear: () => void }): JSX.Element {
  return (
    <div className="connector-pasted">
      <div className="connector-pasted-row">
        <span className="connector-chip">
          <Icon name="check" size={12} />
          {MESSAGE.pasted}
        </span>
        <Button className="connector-chip-button" onClick={onClear}>
          {MESSAGE.clearPaste}
        </Button>
      </div>
      {warnings.map((warning) => (
        <p key={warning} className="connector-hint">
          {warning}
        </p>
      ))}
    </div>
  );
}

/** Servers a paste held besides the one in the form, or all of them before one is picked. */
function PasteChoices({
  choices,
  filled,
  onChoose,
}: {
  choices: McpDraft[];
  filled: boolean;
  onChoose: (item: McpDraft) => void;
}): JSX.Element | null {
  if (!choices.length) return null;
  const legend = filled ? MESSAGE.alsoPasted : MESSAGE.choose(choices.length);
  return (
    <fieldset className="connector-choices">
      <legend className="connector-hint">{legend}</legend>
      <div className="connector-choice-row">
        {choices.map((item) => (
          <Button key={item.connector.id} onClick={() => onChoose(item)}>
            {item.connector.name}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

/** The transport a place keeps: a URL server stays SSE when it already was. */
function transportFor(place: ServerPlace, connector: McpConnectorDraft): McpTransport {
  if (place === ServerPlace.Mac) return McpTransport.Stdio;
  return connector.transport === McpTransport.Sse ? McpTransport.Sse : McpTransport.Http;
}

/** On this Mac or From a URL. */
function PlaceSwitch({ draft, update }: FormProps): JSX.Element {
  const place = isLocal(draft.connector) ? ServerPlace.Mac : ServerPlace.Url;
  const items = [ServerPlace.Mac, ServerPlace.Url].map((key) => ({ key, label: MESSAGE.places[key] }));
  return (
    <ViewSwitcher
      items={items}
      active={place}
      sans
      fullWidth
      label={MESSAGE.place}
      dataAttribute="data-server-place"
      onSelect={(next) => update((d) => withTransport(d, transportFor(next, d.connector)))}
    />
  );
}

/** The program and its arguments as one line, or the address. */
function LaunchField({ draft, update, patch }: FormProps): JSX.Element {
  if (!isLocal(draft.connector))
    return (
      <Field
        label={MESSAGE.url}
        mono
        placeholder="https://mcp.example.com/mcp"
        hint={MESSAGE.urlHint}
        value={draft.connector.url ?? ""}
        onChange={(next) => patch({ url: next })}
      />
    );
  const unfinished = draftProblem(draft) === DraftProblem.UnfinishedCommand;
  return (
    <Field
      label={MESSAGE.command}
      mono
      placeholder="npx -y @modelcontextprotocol/server-github"
      hint={unfinished ? MESSAGE.unfinishedCommand : MESSAGE.commandHint}
      invalid={unfinished}
      value={draft.commandLine}
      onChange={(next) => update((d) => ({ ...d, commandLine: next }))}
    />
  );
}

/** One secret's row: its name, its value (typed, never shown back) and Remove. */
function SecretRowFields({
  row,
  kind,
  stored,
  secretsAvailable,
  onChange,
  onRemove,
}: {
  row: SecretRow;
  kind: "env" | "header";
  stored: boolean;
  secretsAvailable: boolean;
  onChange: (next: SecretRow) => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="connector-secret">
      <input
        aria-label={`${MESSAGE.secrets[kind]}: name`}
        className="font-mono"
        spellCheck={false}
        autoComplete="off"
        placeholder={MESSAGE.secretName[kind]}
        value={row.name}
        onChange={(event) => onChange({ ...row, name: event.target.value })}
      />
      <input
        type="password"
        aria-label={`Value for ${row.name || "this row"}`}
        autoComplete="off"
        placeholder={stored ? MESSAGE.secretStored : MESSAGE.secretValue}
        disabled={!secretsAvailable}
        value={row.value}
        onChange={(event) => onChange({ ...row, value: event.target.value })}
      />
      <Button variant="ghost" size="icon" aria-label={MESSAGE.removeSecret(row.name)} onClick={onRemove}>
        <Icon name="trash" size={14} />
      </Button>
    </div>
  );
}

/** The server's secrets: variables on this Mac, headers for a URL; the lock note only when one is typed. */
function Secrets({
  props,
  stored,
  secretsAvailable,
  secretsLocked,
}: {
  props: FormProps;
  stored: Set<string>;
  secretsAvailable: boolean;
  secretsLocked: SecretStorageIssue;
}): JSX.Element {
  const { draft, update } = props;
  const kind = isLocal(draft.connector) ? "env" : "header";
  const setRows = (rows: (current: SecretRow[]) => SecretRow[]): void =>
    update((d) => ({ ...d, secretRows: rows(d.secretRows) }));
  const badName = draftProblem(draft) === DraftProblem.BadSecretName;
  return (
    <div className="connector-secrets">
      {draft.secretRows.length > 0 && <span className="connector-label">{MESSAGE.secrets[kind]}</span>}
      {draft.secretRows.map((row, index) => (
        <SecretRowFields
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position while its name is being typed
          key={index}
          row={row}
          kind={kind}
          stored={stored.has(`${kind}.${row.name.trim()}`)}
          secretsAvailable={secretsAvailable}
          onChange={(next) => setRows((rows) => rows.map((r, i) => (i === index ? next : r)))}
          onRemove={() => setRows((rows) => rows.filter((_, i) => i !== index))}
        />
      ))}
      {badName && <p className="text-red">{MESSAGE.badSecretName}</p>}
      {!secretsAvailable && draft.secretRows.length > 0 && (
        <p className="text-orange">{SECRETS_LOCKED[secretsLocked]}</p>
      )}
      <Button
        variant="link"
        className="connector-add-secret"
        onClick={() => setRows((rows) => [...rows, { name: "", value: "" }])}
      >
        <Icon name="plus" size={14} />
        {MESSAGE.addSecret[kind]}
      </Button>
    </div>
  );
}

/** A checkbox line of More options. */
function Option({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="connector-option">
      <Checkbox checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {hint && <span className="connector-hint">{hint}</span>}
      </span>
    </label>
  );
}

/** Whether a saved server already uses something More options holds, so it opens unfolded. */
const usesMoreOptions = (connector: McpConnectorDraft): boolean =>
  connector.scope !== "global" || connector.shareProjectRoot === true || Boolean(connector.cwd);

/** Where it may be used, what it may see, where it starts, and the name its tools carry. */
function MoreOptions({
  props,
  project,
  toolId,
}: {
  props: FormProps;
  project: string | null | undefined;
  toolId: string;
}): JSX.Element {
  const { draft, patch } = props;
  const [open, setOpen] = useState(() => !draft.isNew && usesMoreOptions(draft.connector));
  return (
    <div className="connector-more">
      <button type="button" className="connector-more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
        {MESSAGE.more}
      </button>
      {open && (
        <div className="connector-more-body">
          <Option
            label={MESSAGE.onlyHere}
            hint={MESSAGE.onlyHereHint}
            checked={draft.connector.scope !== "global"}
            disabled={!project && draft.connector.scope === "global"}
            onChange={(only) => patch({ scope: only && project ? { projects: [project] } : "global" })}
          />
          <Option
            label={MESSAGE.seeFolder}
            checked={draft.connector.shareProjectRoot === true}
            onChange={(share) => patch({ shareProjectRoot: share })}
          />
          {isLocal(draft.connector) && (
            <Field
              label={MESSAGE.startIn}
              mono
              placeholder={MESSAGE.startInHint}
              value={draft.connector.cwd ?? ""}
              onChange={(next) => patch({ cwd: next })}
            />
          )}
          <p className="connector-hint">{MESSAGE.toolPrefix(toolId)}</p>
        </div>
      )}
    </div>
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
      <span className="connector-label">{MESSAGE.tools}</span>
      {tools.map((tool) => (
        <div key={tool.name} className="flex flex-col gap-1 text-xs">
          <label className="flex items-start gap-2">
            <Checkbox
              checked={toolAllowed(draft.connector.toolPolicy, tool.name)}
              onChange={(event) => onToolAllowed(tool.name, event.target.checked)}
            />
            <span className="font-mono text-micro">{tool.name}</span>
            <span className="min-w-0 flex-1 truncate text-ink-3">{tool.description}</span>
          </label>
          <label className="flex items-center gap-2 pl-5 text-micro text-ink-3">
            <Checkbox
              aria-label={`Allow ${tool.name} without asking`}
              disabled={!toolAllowed(draft.connector.toolPolicy, tool.name)}
              checked={draft.connector.toolPolicy.autoApprove?.includes(tool.name) === true}
              onChange={(event) => onToolAutoApproved(tool.name, event.target.checked)}
            />
            {MESSAGE.autoApprove}
          </label>
        </div>
      ))}
    </div>
  );
}

/** A paste waiting to fill the form, or one that did: what it held and what it warned about. */
export interface PasteState {
  /** The paste filled the form; false while the box is still waiting. */
  filled: boolean;
  warnings: string[];
  /** Servers the paste held when it held more than one. */
  choices: McpDraft[];
}

/** Everything the window shows and the actions it offers. */
export interface ConnectorDialogProps {
  props: FormProps;
  project: string | null | undefined;
  /** Ids already in use, so a new server's id steps aside. */
  takenIds: ReadonlySet<string>;
  tools: McpToolSummary[];
  stored: Set<string>;
  secretsAvailable: boolean;
  /** Why `secretsAvailable` is false; without one the form names missing OS encryption. */
  secretsLocked?: SecretStorageIssue;
  paste: PasteState;
  error: string;
  busy: boolean;
  onPaste: (text: string) => void;
  onChoose: (item: McpDraft) => void;
  onClearPaste: () => void;
  onToolAllowed: (name: string, allowed: boolean) => void;
  onToolAutoApproved: (name: string, approved: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** The paste box, or what the paste filled in, and its choices: only while adding a server. */
function PasteArea({ dialog }: { dialog: ConnectorDialogProps }): JSX.Element | null {
  const { props, paste } = dialog;
  if (!props.draft.isNew) return null;
  return (
    <>
      {paste.filled ? (
        <PastedNote warnings={paste.warnings} onClear={dialog.onClearPaste} />
      ) : (
        <PasteBox warnings={paste.warnings} onRead={dialog.onPaste} />
      )}
      <PasteChoices choices={paste.choices} filled={paste.filled} onChoose={dialog.onChoose} />
    </>
  );
}

/** The window: paste, switch, name, command or URL, secrets, More options, tools, Cancel and Connect. */
export function ConnectorDialog(dialog: ConnectorDialogProps): JSX.Element {
  const { props, busy } = dialog;
  const { draft, patch } = props;
  const problem = draftProblem(draft);
  const toolId = draft.isNew ? connectorIdFor(draft.connector.name, dialog.takenIds) : draft.connector.id;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!busy && !problem) dialog.onSave();
  };
  const primary = draft.isNew ? MESSAGE.connect : MESSAGE.save;
  return (
    <DialogSurface
      title={draft.isNew ? MESSAGE.addTitle : MESSAGE.editTitle(draft.connector.name || draft.connector.id)}
      description={draft.isNew ? MESSAGE.intro : undefined}
      onDismiss={dialog.onCancel}
      dismissible={!busy}
      testId="connector-form"
    >
      <form className="connector-dialog" onSubmit={submit}>
        <PasteArea dialog={dialog} />
        <PlaceSwitch {...props} />
        <Field
          label={MESSAGE.name}
          placeholder={isLocal(draft.connector) ? "GitHub" : "Linear"}
          value={draft.connector.name}
          onChange={(next) => patch({ name: next })}
        />
        <LaunchField {...props} />
        <Secrets
          props={props}
          stored={dialog.stored}
          secretsAvailable={dialog.secretsAvailable}
          secretsLocked={dialog.secretsLocked ?? SecretStorageIssue.EncryptionUnavailable}
        />
        <MoreOptions props={props} project={dialog.project} toolId={toolId || "server"} />
        <ToolChecklist
          tools={dialog.tools}
          draft={draft}
          onToolAllowed={dialog.onToolAllowed}
          onToolAutoApproved={dialog.onToolAutoApproved}
        />
        {dialog.error && (
          <p role="alert" className="extensions-error">
            {dialog.error}
          </p>
        )}
        <div className="connector-actions">
          <Button aria-label="Cancel the connector form" disabled={busy} onClick={dialog.onCancel}>
            {MESSAGE.cancel}
          </Button>
          <Button type="submit" variant="default" busy={busy} disabled={Boolean(problem)}>
            {busy ? MESSAGE.connecting : primary}
          </Button>
        </div>
      </form>
    </DialogSurface>
  );
}
