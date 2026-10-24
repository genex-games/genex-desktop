/** One connector in the list: its row with health and tools, its notes, and — expanded — its actions. */
import type { JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import { McpHealth, type McpConnectorView } from "../../../shared/mcp.ts";
import { Button } from "../../ui/Button.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { PluginIcon } from "../../ui/PluginIcon.tsx";

/**
 * Health in the user's words. Deliberately none of the labels the stage strip and the chat
 * already own — a connector being connected is not the studio being ready for anything, and the
 * build smoke matches those two labels exactly.
 */
const HEALTH_WORDS: Record<McpHealth, string> = {
  [McpHealth.Disabled]: t("off"),
  [McpHealth.Idle]: t("not connected"),
  [McpHealth.Connecting]: t("connecting…"),
  [McpHealth.Ready]: t("connected"),
  [McpHealth.Failed]: t("failed"),
};

type AccountState = NonNullable<McpConnectorView["authentication"]>["state"];

/** Where the connector's account stands, after "Account:". */
const ACCOUNT_WORDS: Record<AccountState, string> = {
  locked: t("locked"),
  "signed-out": t("signed-out"),
  authorizing: t("finish sign-in in your browser"),
  connected: t("connected"),
  failed: t("failed"),
};

/** What a connector's row needs to act: one action at a time, the project, tests' results and the plugin link. */
export interface EntryActions {
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  project: string | null | undefined;
  tested: Record<string, string>;
  setTested: (update: (tested: Record<string, string>) => Record<string, string>) => void;
  onEdit: (view: McpConnectorView) => void;
  onOpenPlugin?: (id: string) => void;
}

type Owner = NonNullable<McpConnectorView["connector"]["source"]>;

/** The plugin a connector belongs to, or null for one the user added. */
const pluginOwner = (view: McpConnectorView): Exclude<Owner, "user"> | null => {
  const source = view.connector.source;
  return source && source !== "user" ? source : null;
};

/** What a test found, in words: how many tools answered and how fast, or why nothing did. */
function testWords(result: Awaited<ReturnType<typeof window.studio.mcpTest>>): string {
  if (!result.ok) return result.error ?? t("no answer");
  return t("{count, plural, one {# tool} other {# tools}} in {ms} ms", {
    count: result.tools.length,
    ms: result.durationMs,
  });
}

/** Whether Connect is worth offering: enabled, not connected or connecting, and no sign-in under way. */
const connectable = (view: McpConnectorView): boolean =>
  view.connector.enabled &&
  view.health !== McpHealth.Ready &&
  view.health !== McpHealth.Connecting &&
  view.authentication?.state !== "authorizing";

/** Test, edit, connect, sign-in, disconnect and remove — the actions of a connector the user owns. */
function OwnActions({ view, actions }: { view: McpConnectorView; actions: EntryActions }): JSX.Element {
  const c = view.connector;
  const { busy, act, project, setTested } = actions;
  const test = () =>
    void window.studio
      .mcpTest(c.id)
      .then((result) => setTested((current) => ({ ...current, [c.id]: testWords(result) })))
      .catch((err: Error) => setTested((current) => ({ ...current, [c.id]: err.message })));
  const connect = () =>
    void act(async () => {
      setTested((current) => {
        const next = { ...current };
        delete next[c.id];
        return next;
      });
      await window.studio.mcpConnect(c.id, project ?? undefined);
    });
  const signIn = view.authentication?.state;
  return (
    <div className="flex flex-wrap gap-2">
      <Button aria-label={t("Test connector {id}", { id: c.id })} disabled={busy} onClick={test}>
        {t("Test")}
      </Button>
      <Button aria-label={t("Edit connector {id}", { id: c.id })} disabled={busy} onClick={() => actions.onEdit(view)}>
        {t("Edit")}
      </Button>
      {connectable(view) && (
        <Button disabled={busy} onClick={connect}>
          {t("Connect")}
        </Button>
      )}
      {signIn === "authorizing" && (
        <Button disabled={busy} onClick={() => void act(() => window.studio.mcpCancelAuthorization(c.id))}>
          {t("Cancel sign-in")}
        </Button>
      )}
      {signIn === "connected" && (
        <Button disabled={busy} onClick={() => void act(() => window.studio.mcpDisconnectAccount(c.id))}>
          {t("Disconnect account")}
        </Button>
      )}
      <Button
        variant="ghost"
        aria-label={t("Remove connector {id}", { id: c.id })}
        disabled={busy}
        onClick={() => void act(() => window.studio.mcpRemove(c.id))}
      >
        {t("Remove")}
      </Button>
    </div>
  );
}

/** The connector's notes: a change waiting to apply, its account, its error, and a launch that needs approving again. */
function EntryNotes({ view, expanded }: { view: McpConnectorView; expanded: boolean }): JSX.Element {
  const c = view.connector;
  const owned = pluginOwner(view);
  const quiet = Boolean(owned && !c.enabled);
  const errorShown = Boolean(view.error) && (c.enabled || expanded);
  return (
    <>
      {view.pending && (
        <p role="status" className="connector-note text-orange">
          {t("Configuration saved. It will apply when existing calls finish. Disabled access is blocked immediately.")}
        </p>
      )}
      {view.authentication && (
        <p role="status" className="connector-note text-ink-3">
          {t("Account: {state}", { state: ACCOUNT_WORDS[view.authentication.state] })}
          {view.authentication.error ? ` · ${view.authentication.error}` : ""}
        </p>
      )}
      {errorShown && (
        <p role={quiet ? undefined : "alert"} className={`connector-note ${quiet ? "text-ink-3" : "text-red"}`}>
          {view.error}
        </p>
      )}
      {!view.trusted && !owned && (
        <p className="connector-note text-orange">
          {t("This connector starts a different program than the one you approved — open Edit and approve it again.")}
        </p>
      )}
    </>
  );
}

/** The connector's status line: that it connects on its own, or its health and tool count; and whose it is. */
function statusLine(view: McpConnectorView): string {
  const c = view.connector;
  const owned = pluginOwner(view);
  const automatic = owned && c.enabled && view.trusted && view.health === McpHealth.Idle && !view.error;
  const state = automatic
    ? t("Connects automatically")
    : t("{health} · {count, plural, one {# tool} other {# tools}}", {
        health: HEALTH_WORDS[view.health],
        count: view.toolCount,
      });
  return owned ? t("{state} · from {plugin}", { state, plugin: owned.plugin }) : state;
}

/** One connector: its row, its notes and, expanded, its details and actions. */
export function ConnectorEntry({
  view,
  expanded,
  onExpand,
  actions,
}: {
  view: McpConnectorView;
  expanded: boolean;
  onExpand: () => void;
  actions: EntryActions;
}): JSX.Element {
  const c = view.connector;
  const owned = pluginOwner(view);
  const { busy, act, project } = actions;
  return (
    <div className="connector-entry">
      <div className="extension-row">
        <button
          type="button"
          className="extension-open"
          aria-label={t("Details for MCP {name}", { name: c.name })}
          aria-expanded={expanded}
          onClick={onExpand}
        >
          <PluginIcon name={view.title ?? c.name} src={view.icon} />
          <span className="extension-copy">
            <span className="extension-name">{view.title ?? c.name}</span>
            <span className="extension-description">{statusLine(view)}</span>
          </span>
        </button>
        {owned ? (
          <Button variant="secondary" onClick={() => actions.onOpenPlugin?.(owned.plugin)}>
            {c.enabled ? t("View plugin") : t("Configure optional connection")}
          </Button>
        ) : (
          <Toggle
            on={c.enabled}
            ariaLabel={t("Use connector {id}", { id: c.id })}
            disabled={busy}
            onChange={(next) =>
              void act(async () => {
                const saved = await window.studio.mcpSave({ ...c, enabled: next });
                if (next && !saved.pending) await window.studio.mcpConnect(c.id, project ?? undefined);
              })
            }
          />
        )}
      </div>
      <EntryNotes view={view} expanded={expanded} />
      {expanded && (
        <div className="connector-details">
          <p className="text-sm text-ink-3">
            {c.transport} · {t("External MCP tools reach every coding agent through Studio.")}
          </p>
          {owned ? (
            <p className="text-sm text-ink-3">{t("This connector belongs to a plugin. Change it in Plugins.")}</p>
          ) : (
            <OwnActions view={view} actions={actions} />
          )}
          {actions.tested[c.id] && <p className="text-sm text-ink-3">{actions.tested[c.id]}</p>}
        </div>
      )}
    </div>
  );
}
