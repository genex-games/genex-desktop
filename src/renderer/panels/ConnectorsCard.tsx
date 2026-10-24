/**
 * Connectors — the MCP servers this Mac's studio attaches to, and the one place they are
 * configured. A connector's tools reach Claude Code, Codex and the local harness alike, because
 * Studio is the MCP client and the agents only ever see `liveTools`.
 *
 * Two rules the card keeps:
 *  - a secret value is typed here and never read back. The list carries the NAMES a connector
 *    declares and which of them have a value stored; the value itself goes straight to the OS
 *    secret store and comes back only as the word "stored".
 *  - a connector a plugin ships is the plugin's. It is listed, because a tool source the agents
 *    can use should never be invisible, but it is changed where it came from.
 *
 * `connectors/` holds the parts: the form's state and save rules, one connector's entry, and the form.
 */
import type { JSX, Ref } from "react";
import { useCallback, useEffect, useImperativeHandle, useState } from "react";
import { errorMessage } from "../../shared/errors.ts";
import { t } from "../../shared/i18n.ts";
import type { McpConnectorView, McpToolSummary } from "../../shared/mcp.ts";
import { type McpConnectorDraft, type McpDraft, parseMcpInput } from "../../shared/mcp-import.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { ConnectorEntry, type EntryActions } from "./connectors/ConnectorEntry.tsx";
import { PluginIcon } from "../ui/PluginIcon.tsx";
import { ConnectorDialog, type FormProps, type PasteState } from "./connectors/ConnectorForm.tsx";
import {
  blankDraft,
  connectorToSave,
  type Draft,
  draftFrom,
  draftFromImport,
  secretsToSave,
  withToolAllowed,
  withToolAutoApproved,
} from "./connectors/draft.ts";
import { Pending } from "../ui/Pending.tsx";
import { PLUGINS_WORDS } from "../words.ts";
import { SkeletonRows } from "../ui/Skeleton.tsx";

/** What the plugins page's Add menu can ask of the card. */
export interface ConnectorActions {
  add: () => void;
}

/** The connectors as the host lists them, re-read whenever the host says they changed. */
function useConnectorViews(project: string | null | undefined, setError: (error: string) => void) {
  const [views, setViews] = useState<McpConnectorView[] | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setViews(await window.studio.mcpList(project ?? null));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project, setError]);

  // One subscription, one first read, both cancelled on unmount: StrictMode mounts this twice.
  useEffect(() => {
    let disposed = false;
    void window.studio
      .mcpList(project ?? null)
      .then((list) => {
        if (!disposed) setViews(list);
      })
      .catch((err: Error) => {
        if (!disposed) setError(err.message);
      });
    const off = window.studio.onEvent((event) => {
      if (event.type === UiEvent.McpChanged && !disposed) void refresh();
    });
    return () => {
      disposed = true;
      off();
    };
  }, [refresh, project, setError]);
  return { views, refresh };
}

/** Whether a connector matches the search, by its name or id. */
const connectorMatches = (view: McpConnectorView, query: string): boolean =>
  `${view.connector.name} ${view.connector.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

/** The connectors a pasted snippet held, waiting to be reviewed one at a time. */
function ImportChoices({
  imports,
  drafting,
  onChoose,
  onDismiss,
}: {
  imports: McpDraft[];
  drafting: boolean;
  onChoose: (item: McpDraft) => void;
  onDismiss: () => void;
}): JSX.Element | null {
  if (!imports.length) return null;
  return (
    <div className="flex flex-col gap-2" aria-label={t("Imported connectors")}>
      <p className="text-sm text-ink-3">
        {t("Choose a connector to review and connect. Existing configurations stay unchanged.")}
      </p>
      {imports.map((item) => (
        <Button key={item.connector.id} disabled={drafting} onClick={() => onChoose(item)}>
          {item.connector.name} · {item.connector.transport}
        </Button>
      ))}
      <Button onClick={onDismiss}>{t("Dismiss remaining imports")}</Button>
    </div>
  );
}

/** Whether a connector is one a plugin ships, rather than one the person added. */
const isPluginServer = (view: McpConnectorView): boolean => typeof view.connector.source === "object";

/**
 * A plugin's server, found by a search: it lives on its plugin's page, so the row says whose it
 * is and opens that page instead of offering a switch here.
 */
function PluginServerRow({
  view,
  pluginName,
  onOpenPlugin,
}: {
  view: McpConnectorView;
  pluginName: string;
  onOpenPlugin?: ((id: string) => void) | undefined;
}): JSX.Element | null {
  const source = view.connector.source;
  if (typeof source !== "object") return null;
  const title = `${source.server.charAt(0).toLocaleUpperCase()}${source.server.slice(1)}`;
  return (
    <div className="extension-row" data-plugin-server={source.server}>
      <div className="extension-open extension-static">
        <PluginIcon name={title} src={view.icon} />
        <span className="extension-copy">
          <span className="extension-name">{view.title ?? title}</span>
          <span className="extension-description">{t("Part of {plugin}", { plugin: pluginName })}</span>
        </span>
      </div>
      <Button variant="ghost" onClick={() => onOpenPlugin?.(source.plugin)}>
        {t("Open {plugin}", { plugin: pluginName })}
        <Icon name="chevron-right" size={14} />
      </Button>
    </div>
  );
}

/**
 * The card's list: every server the person added, on or off, each with its own switch; a plugin's
 * own servers only when a search finds them, pointing to where they live.
 */
function ConnectorList({
  views,
  query,
  actions,
  pluginName,
}: {
  views: McpConnectorView[] | null;
  query: string;
  actions: EntryActions;
  pluginName: (id: string) => string;
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  const searching = Boolean(query.trim());
  const matching = (views ?? []).filter((view) => connectorMatches(view, query));
  const own = matching.filter((view) => !isPluginServer(view));
  const plugins = searching ? matching.filter(isPluginServer) : [];
  const noMatch = searching && Boolean(views?.length) && matching.length === 0;
  return (
    <>
      {own.map((view) => (
        <ConnectorEntry
          key={view.connector.id}
          view={view}
          expanded={expanded === view.connector.id}
          onExpand={() => setExpanded(expanded === view.connector.id ? null : view.connector.id)}
          actions={actions}
        />
      ))}
      {plugins.map((view) => {
        const source = view.connector.source;
        const owner = typeof source === "object" ? pluginName(source.plugin) : "";
        return (
          <PluginServerRow key={view.connector.id} view={view} pluginName={owner} onOpenPlugin={actions.onOpenPlugin} />
        );
      })}
      {noMatch && <p className="extensions-empty">{t("No MCP servers match your search.")}</p>}
    </>
  );
}

/** The card's opening lines: loading, nothing configured, and its error. */
function CardNotices({
  views,
  error,
  drafting,
}: {
  views: McpConnectorView[] | null;
  error: string;
  drafting: boolean;
}): JSX.Element {
  const noServers = views !== null && !views.some((view) => !isPluginServer(view)) && !drafting;
  return (
    <>
      {views === null && !error && (
        <Pending label={t("Loading MCP servers…")} className="py-3">
          <SkeletonRows count={2} icon />
        </Pending>
      )}
      {noServers && (
        <div className="extension-row extension-servers-empty">
          <span className="extension-icon extension-icon-row extension-icon-make" aria-hidden="true">
            <Icon name="plugins" size={19} />
          </span>
          <span className="extension-copy">
            <span className="extension-name">{PLUGINS_WORDS.servers.emptyTitle}</span>
            <span className="extension-description">{PLUGINS_WORDS.servers.emptyText}</span>
          </span>
        </div>
      )}
      {error && !drafting && (
        <p role="alert" className="extensions-error">
          {error}
        </p>
      )}
    </>
  );
}

/** A paste box that has read nothing yet. */
const NO_PASTE: PasteState = { filled: false, warnings: [], choices: [] };

/** The form's state: the draft, the server's tools, and what a paste filled in or held. */
function useConnectorDraft() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tools, setTools] = useState<McpToolSummary[]>([]);
  const [paste, setPaste] = useState<{ filled: boolean; warnings: string[] }>(NO_PASTE);
  const [imports, setImports] = useState<McpDraft[]>([]);
  const update = (change: (draft: Draft) => Draft): void =>
    setDraft((current) => (current ? change(current) : current));
  const patch = (change: Partial<McpConnectorDraft>): void =>
    update((current) => ({ ...current, connector: { ...current.connector, ...change } }));
  const importDraft = (item: McpDraft): void => {
    setDraft(draftFromImport(item));
    setTools([]);
    setPaste((current) => ({ ...current, filled: true }));
    setImports((current) => current.filter((d) => d !== item));
  };
  const readPaste = (text: string): void => {
    const parsed = parseMcpInput(text);
    setPaste({ filled: false, warnings: parsed.warnings });
    setImports(parsed.drafts.length > 1 ? parsed.drafts : []);
    const only = parsed.drafts.length === 1 ? parsed.drafts[0] : undefined;
    if (only) importDraft(only);
  };
  const clearPaste = (): void => {
    setDraft(blankDraft());
    setPaste(NO_PASTE);
    setImports([]);
  };
  const close = (): void => {
    setDraft(null);
    setTools([]);
    setPaste(NO_PASTE);
  };
  return {
    draft,
    setDraft,
    tools,
    setTools,
    paste,
    imports,
    setImports,
    update,
    patch,
    importDraft,
    readPaste,
    clearPaste,
    close,
  };
}

/** Add, as the plugins page's menu calls it. */
function useFormOpener(
  ref: Ref<ConnectorActions> | undefined,
  d: ReturnType<typeof useConnectorDraft>,
  setError: (error: string) => void,
) {
  const addConnector = () => {
    setError("");
    d.clearPaste();
    d.setTools([]);
  };
  useImperativeHandle(ref, () => ({ add: addConnector }));
  return addConnector;
}

/** Open a saved connector in the form, and list its tools for the checklist. */
function editConnector(
  view: McpConnectorView,
  d: ReturnType<typeof useConnectorDraft>,
  setError: (error: string) => void,
): void {
  d.setDraft(draftFrom(view));
  d.setTools([]);
  setError("");
  // Listing a server's tools means starting it, and a connector whose recorded command is not the
  // one that was approved refuses. Editing it is exactly how that is put right, so the form opens
  // either way and the refusal is said out loud instead of leaving a silently empty checklist.
  void window.studio
    .mcpTools(view.connector.id)
    .then(d.setTools)
    .catch((err: Error) => {
      d.setTools([]);
      setError(err.message);
    });
}

/** One connector action at a time: busy while it runs, its failure said, the list read again after. */
function useConnectorAct(refresh: () => Promise<void>, setError: (error: string) => void) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  return { busy, act };
}

/** Save the form's connector with its secrets, close the form, and connect it when it may run now. */
async function saveDraft(
  draft: Draft,
  taken: ReadonlySet<string>,
  d: ReturnType<typeof useConnectorDraft>,
  act: EntryActions["act"],
  project: string | null | undefined,
): Promise<void> {
  const connector = connectorToSave(draft, taken);
  const secrets = secretsToSave(draft);
  await act(async () => {
    const saved = await window.studio.mcpSave(connector, Object.keys(secrets).length ? secrets : undefined);
    d.close();
    if (saved.connector.enabled && !saved.pending) {
      // Connection/authentication progress belongs to the live host view. OAuth can
      // finish after this request returns; retaining its initial challenge is stale.
      await window.studio.mcpConnect(saved.connector.id, project ?? undefined);
    }
  });
}

/** The Add or Edit window over the card, while a draft is open. */
function CardDialog({
  d,
  views,
  project,
  error,
  setError,
  busy,
  act,
}: {
  d: ReturnType<typeof useConnectorDraft>;
  views: McpConnectorView[] | null;
  project: string | null | undefined;
  error: string;
  setError: (error: string) => void;
  busy: boolean;
  act: EntryActions["act"];
}): JSX.Element | null {
  const { draft } = d;
  if (!draft) return null;
  const taken = new Set((views ?? []).map((view) => view.connector.id));
  const editingView = draft.isNew ? undefined : views?.find((v) => v.connector.id === draft.connector.id);
  return (
    <ConnectorDialog
      props={{ draft, update: d.update, patch: d.patch } satisfies FormProps}
      project={project}
      takenIds={taken}
      tools={d.tools}
      stored={new Set(editingView?.secrets ?? [])}
      secretsAvailable={views?.[0]?.secretsAvailable ?? true}
      secretsLocked={views?.[0]?.secretsLocked}
      paste={{ ...d.paste, choices: d.imports }}
      error={error}
      busy={busy}
      onPaste={d.readPaste}
      onChoose={d.importDraft}
      onClearPaste={d.clearPaste}
      onToolAllowed={(name, allowed) =>
        d.patch({ toolPolicy: withToolAllowed(draft.connector.toolPolicy, name, allowed) })
      }
      onToolAutoApproved={(name, approved) =>
        d.patch({ toolPolicy: withToolAutoApproved(draft.connector.toolPolicy, name, approved) })
      }
      onSave={() => void saveDraft(draft, taken, d, act, project)}
      onCancel={() => {
        d.close();
        setError("");
      }}
    />
  );
}

export function ConnectorsCard({
  project,
  query = "",
  onOpenPlugin,
  pluginName = (id) => id,
  ref,
}: {
  project?: string | null;
  query?: string;
  onOpenPlugin?: (id: string) => void;
  /** A plugin's name, for the servers a search finds that belong to it. */
  pluginName?: (id: string) => string;
  ref?: Ref<ConnectorActions>;
}): JSX.Element {
  const [error, setError] = useState("");
  const { views, refresh } = useConnectorViews(project, setError);
  const d = useConnectorDraft();
  const { busy, act } = useConnectorAct(refresh, setError);
  const [tested, setTested] = useState<Record<string, string>>({});
  const addConnector = useFormOpener(ref, d, setError);
  const edit = (view: McpConnectorView): void => editConnector(view, d, setError);
  const ownCount = (views ?? []).filter((view) => !isPluginServer(view)).length;
  const actions: EntryActions = { busy, act, project, tested, setTested, onEdit: edit, onOpenPlugin };

  return (
    <section data-testid="mcp-connectors" className="extensions-section">
      <div className="extensions-section-heading">
        <h2>
          {t("MCP servers")}
          {ownCount > 0 && <span className="ml-2 text-ink-3">{ownCount}</span>}
        </h2>
        <Button variant="ghost" aria-label={t("Add connector")} onClick={addConnector}>
          <Icon name="plus" size={14} />
          {t("Add server")}
        </Button>
      </div>
      <CardNotices views={views} error={error} drafting={Boolean(d.draft)} />
      <ImportChoices
        imports={d.imports}
        drafting={Boolean(d.draft)}
        onChoose={d.importDraft}
        onDismiss={() => d.setImports([])}
      />
      <ConnectorList views={views} query={query} actions={actions} pluginName={pluginName} />
      <CardDialog d={d} views={views} project={project} error={error} setError={setError} busy={busy} act={act} />
    </section>
  );
}
