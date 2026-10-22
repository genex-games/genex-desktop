/**
 * A plugin's own MCP servers on its page, as Connections: each with its picture, a name and one
 * line, and where it stands (Ready, Off, waiting on the account) or the one setting it needs.
 * They used to hide on the Plugins list behind "Show disabled and optional connections". An engine
 * plugin's connection is only as ready as its editor: once on, it says what its toolbar button
 * says (Not installed, Not set up, Not open, Starting, Ready), not the bridge's own Ready.
 */
import type { JSX } from "react";
import { useState } from "react";
import { McpHealth, type McpConnectorView } from "../../../shared/mcp.ts";
import { toolbarStatusFrom } from "../../../shared/plugin-toolbar.ts";
import {
  type PluginInfo,
  type PluginMcpServer,
  PluginAccountState,
  PluginCapability,
  type PluginToolbarStatus,
} from "../../../shared/plugins.ts";
import { Button } from "../../ui/Button.tsx";
import { useAsyncEffect } from "../../use-async-effect.ts";
import { UNREAL_PLUGIN_ID } from "../../unreal-game.ts";
import { UNITY_PLUGIN_ID } from "../../../shared/observers.ts";
import { PLUGINS_WORDS, UNITY_WORDS, UNREAL_WORDS, consentToolWords } from "../../words.ts";
import { isActive, pluginAccount, pluginIconUrl } from "./labels.ts";
import { type PluginsPage, usePluginServers } from "./page.ts";
import { PluginIcon } from "../../ui/PluginIcon.tsx";
import { Section } from "./rows.tsx";

const WORDS = PLUGINS_WORDS.page;

/** How a page names one of its plugin's servers; `setting` names the one setting it needs, as its field says it. */
export interface ConnectionNames {
  title: string;
  text: string;
  setting?: string;
}

/** Where a server stands, in the order a person has to deal with it. */
const ConnectionState = {
  Off: "off",
  NeedsSetting: "needs-setting",
  NeedsAccount: "needs-account",
  Connecting: "connecting",
  Failed: "failed",
  Ready: "ready",
} as const;
type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];

/** A server's state from its plugin, its required settings and account, and how the host runs it. */
function connectionState(
  plugin: PluginInfo,
  server: PluginMcpServer,
  view: McpConnectorView | undefined,
  context: { settings: Record<string, unknown> | null; account: string | undefined },
): ConnectionState {
  if (!isActive(plugin)) return ConnectionState.Off;
  const missing = (server.requires?.settings ?? []).some((key) => !context.settings?.[key]);
  if (context.settings && missing) return ConnectionState.NeedsSetting;
  if (server.requires?.credential && context.account !== PluginAccountState.Unlocked)
    return ConnectionState.NeedsAccount;
  if (view?.health === McpHealth.Failed) return ConnectionState.Failed;
  if (view?.health === McpHealth.Connecting) return ConnectionState.Connecting;
  return view && view.connector.enabled ? ConnectionState.Ready : ConnectionState.Off;
}

const STATE_WORDS: Record<ConnectionState, string> = {
  off: WORDS.off,
  "needs-setting": WORDS.off,
  "needs-account": WORDS.needsAccount,
  connecting: WORDS.connecting,
  failed: WORDS.failed,
  ready: WORDS.ready,
};

/**
 * The first sentence of a manifest description: the server's one line when the page has no name
 * for it. A stop ends it only before a space or the end, so "Unreal Editor 5.8" stays whole.
 */
const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/s.exec(text)?.[0]?.trim() || text;

/** Studio's own names for a bundled plugin's servers, by plugin and server id, where the manifest's line speaks to agents. */
const OWN_NAMES: Readonly<Record<string, Readonly<Record<string, ConnectionNames>>>> = {
  [UNREAL_PLUGIN_ID]: { editor: UNREAL_WORDS.connection },
  [UNITY_PLUGIN_ID]: { editor: UNITY_WORDS.connection },
};

/**
 * An engine plugin's word for where its editor stands, from its toolbar button's status action,
 * asked while the plugin is on; null for any other plugin or until it answers.
 */
function useEngineWord(plugin: PluginInfo, project: string | null | undefined): PluginToolbarStatus | null {
  const [word, setWord] = useState<PluginToolbarStatus | null>(null);
  const engine = plugin.manifest.capabilities.includes(PluginCapability.GameEngine);
  const action = engine && isActive(plugin) ? plugin.manifest.toolbar?.find((item) => item.status)?.status : undefined;
  useAsyncEffect(
    (alive) => {
      if (!action) return;
      window.studio.pluginAction(plugin.manifest.id, action, {}, project ?? undefined).then(
        (value) => alive() && setWord(toolbarStatusFrom(value)),
        () => alive() && setWord(null),
      );
    },
    [plugin.manifest.id, action, project],
  );
  return action ? word : null;
}
/** A server id as a name: `creator` reads "Creator". */
const titleOf = (id: string): string => `${id.charAt(0).toLocaleUpperCase()}${id.slice(1).replaceAll("-", " ")}`;

/** The one setting a server needs, edited in place: Set …, then the field and Save. */
function SettingEditor({
  plugin,
  page,
  settingKey,
  label,
  value,
  onSaved,
}: {
  plugin: PluginInfo;
  page: PluginsPage;
  settingKey: string;
  label: string;
  value: string;
  onSaved: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!open)
    return (
      <Button disabled={page.busy} onClick={() => setOpen(true)}>
        {value ? PLUGINS_WORDS.github.change : WORDS.set(label)}
      </Button>
    );
  return (
    <form
      className="extension-connection-setting"
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        void page.act(async () => {
          await window.studio.pluginSetSetting(plugin.manifest.id, settingKey, next);
          onSaved(next);
          setOpen(false);
        });
      }}
    >
      <input
        className="extension-input"
        aria-label={label}
        placeholder={label}
        value={draft}
        autoFocus
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button type="submit" variant="default" disabled={page.busy}>
        {WORDS.save}
      </Button>
    </form>
  );
}

/** The tools a person always allowed for this server, and the button that makes each ask again. */
function AlwaysAllowed({ page, view }: { page: PluginsPage; view: McpConnectorView | undefined }): JSX.Element | null {
  const tools = view?.connector.toolPolicy.autoApprove ?? [];
  if (!view || !tools.length) return null;
  return (
    <span className="extension-description" data-always-allowed="">
      {WORDS.alwaysAllowed(tools.map((tool) => consentToolWords(tool)).join(", "))}{" "}
      <Button
        variant="ghost"
        disabled={page.busy}
        onClick={() => void page.act(() => window.studio.mcpForgetAlwaysAllowed(view.connector.id))}
      >
        {WORDS.askEveryTime}
      </Button>
    </span>
  );
}

/** One server's row. */
function ConnectionRow({
  plugin,
  page,
  server,
  view,
  names,
  settings,
  onSaved,
}: {
  plugin: PluginInfo;
  page: PluginsPage;
  server: PluginMcpServer;
  view: McpConnectorView | undefined;
  names: ConnectionNames | undefined;
  settings: Record<string, unknown> | null;
  onSaved: (key: string, value: string) => void;
}): JSX.Element {
  const account = pluginAccount(page.connections, plugin.manifest.id);
  const state = connectionState(plugin, server, view, { settings, account });
  const engineWord = useEngineWord(plugin, page.project);
  // A ready bridge to an editor that isn't ready reads as the editor's own state, with no green dot.
  const editorWord = state === ConnectionState.Ready ? engineWord?.badge : undefined;
  const title = names?.title ?? titleOf(server.id);
  const settingKey = server.requires?.settings?.[0];
  const setting = plugin.manifest.settings.find((s) => s.key === settingKey);
  const label = names?.setting ?? setting?.label ?? "";
  const editable = Boolean(setting && settings && isActive(plugin));
  return (
    <div className="extension-row" data-plugin-connection={server.id} data-state={state}>
      <div className="extension-open extension-static">
        <PluginIcon name={title} src={pluginIconUrl(plugin)} />
        <span className="extension-copy">
          <span className="extension-name">{title}</span>
          <span className="extension-description">{names?.text ?? firstSentence(server.description)}</span>
        </span>
      </div>
      {state !== ConnectionState.NeedsSetting && (
        <span
          className="extension-connection-state"
          data-state={state}
          data-engine-word={editorWord ? "" : undefined}
          title={editorWord ? engineWord?.title : undefined}
        >
          {state === ConnectionState.Ready && !editorWord && <span className="extension-dot" aria-hidden="true" />}
          {editorWord ?? STATE_WORDS[state]}
        </span>
      )}
      <AlwaysAllowed page={page} view={view} />
      {editable && settingKey && (
        <SettingEditor
          plugin={plugin}
          page={page}
          settingKey={settingKey}
          label={label}
          value={String(settings?.[settingKey] ?? "")}
          onSaved={(value) => onSaved(settingKey, value)}
        />
      )}
    </div>
  );
}

/** The plugin's servers, when it ships any; `names` gives a page its own names for them, by server id. */
export function PluginConnections({
  plugin,
  page,
  names = {},
}: {
  plugin: PluginInfo;
  page: PluginsPage;
  names?: Readonly<Record<string, ConnectionNames>>;
}): JSX.Element | null {
  const { manifest } = plugin;
  const servers = manifest.mcpServers ?? [];
  const views = usePluginServers(manifest.id, page.project);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const needsSettings = servers.some((s) => (s.requires?.settings ?? []).length > 0);
  const active = isActive(plugin);
  useAsyncEffect(
    (alive) => {
      if (!needsSettings || !active) return;
      window.studio.pluginSettings(manifest.id).then(
        (values) => alive() && setSettings(values),
        () => alive() && setSettings(null),
      );
    },
    [manifest.id, needsSettings, active],
  );
  if (!servers.length) return null;
  return (
    <Section title={WORDS.connections} count={servers.length} hooks={{ "data-plugin-connections": "" }}>
      {servers.map((server) => (
        <ConnectionRow
          key={server.id}
          plugin={plugin}
          page={page}
          server={server}
          view={views.find((v) => typeof v.connector.source === "object" && v.connector.source.server === server.id)}
          names={names[server.id] ?? OWN_NAMES[manifest.id]?.[server.id]}
          settings={settings}
          onSaved={(key, value) => setSettings((current) => ({ ...current, [key]: value }))}
        />
      ))}
    </Section>
  );
}
