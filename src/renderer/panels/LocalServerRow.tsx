import { t } from "../../shared/i18n.ts";
import type { ModelOverride } from "../../shared/local-server.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Icon } from "../ui/icons.tsx";
/**
 * Settings → Model Providers, the local server row: a model server the person runs (LM Studio,
 * llama.cpp, TabbyAPI, vLLM, KoboldCpp). It keeps a provider row's shape (`provider-row.tsx`): one
 * status plate, one line, at most one visible action and a menu once a server is saved. Until then
 * it offers the servers running on this computer and an address with an optional key. The key goes
 * straight to main, which checks it with the server and keeps it in the OS secret store; it is
 * never shown again, and the field forgets it the moment it is sent.
 */
import { type FormEvent, type JSX, useEffect, useRef, useState } from "react";
import { EngineId } from "../../shared/providers.ts";
import type { FoundLocalServer, LocalServerInfo } from "../../shared/local-server.ts";
import {
  reportClock,
  reportLocalServerConnect,
  reportLocalServersFound,
  reportProviderPress,
  useRowViewed,
} from "../analytics/welcome-report.ts";
import { LocalServerVia, ProviderAction, ProviderSurface } from "../analytics/welcome-vocabulary.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { DropdownMenuItem } from "../ui/dropdown-menu.tsx";
import { LOCAL_SERVER_WORDS, METERED_PROVIDER_WORDS } from "../words.ts";
import {
  isKeyRefusal,
  kindName,
  LocalServerRowState,
  localServerRowState,
  modelDetails,
  type Refusal,
  rowHint,
  rowProblem,
  serverHost,
  serverLine,
} from "./local-server-row.ts";
import { AccountMenu, ItemWords, useRecheck, useRun } from "./MeteredProviders.tsx";
import { type ProviderWords, RowHeading, RowTone, type RowView } from "./provider-row.tsx";

const WORDS = LOCAL_SERVER_WORDS;
const ROW_WORDS: ProviderWords = { name: WORDS.name, plans: "", guide: "" };
const FIELD =
  "h-8 min-w-0 rounded-control border border-input bg-field px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-accent-ink";

/** The row's actions: check again (saying which button asked), change the address, or disconnect. */
type RowActions = { recheck: (pressed: ProviderAction) => void; change: () => void; disconnect: () => void };

/** The saved server's menu: Check connection, then Change address… and Disconnect. */
function ServerMenu({ act }: { act: RowActions }): JSX.Element {
  return (
    <AccountMenu
      name={WORDS.name}
      label={WORDS.menu}
      menuName={WORDS.menuName}
      onCheck={() => act.recheck(ProviderAction.CheckConnection)}
    >
      <>
        <DropdownMenuItem onSelect={() => void window.studio.localServerOpenConfig()}>
          <ItemWords
            title={t("Open model settings (models.json)…")}
            line={t("Edit context and vision configuration file")}
          />
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={act.change}>
          <ItemWords title={WORDS.change} line={WORDS.changeLine} />
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={act.disconnect}>{WORDS.disconnect}</DropdownMenuItem>
      </>
    </AccountMenu>
  );
}

/** A saved server that needs the person: its plate, its line, and Check again beside the menu. */
function troubleView(tone: RowTone, status: string, line: string, act: RowActions, retry = true): RowView {
  return {
    tone,
    status,
    line,
    actions: (
      <>
        {retry && (
          <Button onClick={() => act.recheck(ProviderAction.Recheck)}>{METERED_PROVIDER_WORDS.checkAgain}</Button>
        )}
        <ServerMenu act={act} />
      </>
    ),
  };
}

/** The row by its state: nothing saved, connecting, connected, or a saved server that needs something. */
function localServerView(
  state: LocalServerRowState,
  engine: EngineDescriptor,
  server: LocalServerInfo | null,
  act: RowActions,
): RowView {
  const named = kindName(server?.kind) ?? WORDS.theServer;
  switch (state) {
    case LocalServerRowState.NotSetUp:
      return {
        tone: RowTone.Off,
        status: METERED_PROVIDER_WORDS.notConnected,
        line: WORDS.notConnectedLine,
        actions: null,
      };
    case LocalServerRowState.Connecting:
      return {
        tone: RowTone.Busy,
        status: WORDS.connecting,
        line: server ? serverLine(server) : WORDS.notConnectedLine,
        actions: null,
      };
    case LocalServerRowState.Connected:
      return {
        tone: RowTone.Connected,
        status: WORDS.connected,
        line: server ? serverLine(server) : null,
        actions: <ServerMenu act={act} />,
      };
    case LocalServerRowState.NotRunning:
      return troubleView(RowTone.Warning, WORDS.notRunning, WORDS.notRunningLine(serverHost(server?.url ?? "")), act);
    case LocalServerRowState.NeedsKey:
      return troubleView(
        RowTone.Warning,
        WORDS.needsKey,
        WORDS.needsKeyLine(server ? serverLine(server) : named),
        act,
        false,
      );
    case LocalServerRowState.NoModels:
      return troubleView(RowTone.Warning, WORDS.noModels, WORDS.noModelsLine(named), act);
    default:
      return troubleView(RowTone.Danger, METERED_PROVIDER_WORDS.couldNotCheck, engine.status.detail, act);
  }
}

/** The servers answering on this computer's usual ports, each one click from connected. */
function FoundServers({ found, onUse }: { found: FoundLocalServer[]; onUse: (server: FoundLocalServer) => void }) {
  return (
    // Each server is named by its address on this network: a replay shows them masked.
    <div
      role="group"
      aria-label={WORDS.found}
      className="flex flex-col gap-1"
      data-local-server-found
      data-analytics-mask
    >
      <span className="text-body-sm font-medium text-ink">{WORDS.found}</span>
      {found.map((server) => (
        <div key={server.url} className="flex min-h-9 items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
            <span className="text-sm text-ink">{serverLine(server)}</span>
            <span className="text-micro text-muted-foreground">
              {server.needsKey ? WORDS.foundNeedsKey : WORDS.foundModels(server.models)}
            </span>
          </div>
          <Button data-local-server-use={server.url} onClick={() => onUse(server)}>
            {WORDS.use}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** The servers found on this computer, asked once when the form opens; none while asking or when asking fails. */
function useFoundServers(): FoundLocalServer[] {
  const [found, setFound] = useState<FoundLocalServer[]>([]);
  useEffect(() => {
    let live = true;
    window.studio
      .localServerFind()
      .then((servers) => {
        if (!live) return;
        reportLocalServersFound(servers);
        setFound(servers);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return found;
}

/**
 * The address and key, with the servers found on this computer above them. A found server that
 * wants no key connects at once; one that wants a key fills the address and waits for it.
 */
function AddressEntry({
  initialUrl,
  busy,
  askedForKey,
  onConnect,
  onCancel,
}: {
  initialUrl: string;
  busy: boolean;
  /** The server just asked for a key: the key field takes focus. */
  askedForKey: boolean;
  /** Connect: the address, the key, and whether it was typed or a found server's Use (usage analytics). */
  onConnect: (url: string, key: string, via: LocalServerVia) => void;
  onCancel: (() => void) | null;
}): JSX.Element {
  const [url, setUrl] = useState(initialUrl);
  const [key, setKey] = useState("");
  const keyField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (askedForKey && !busy) keyField.current?.focus();
  }, [askedForKey, busy]);
  const found = useFoundServers().filter((server) => server.url !== initialUrl);
  const send = (address: string, via: LocalServerVia): void => {
    const pasted = key;
    // The field forgets the key the moment it is sent.
    setKey("");
    onConnect(address, pasted, via);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (url.trim() && !busy) send(url, LocalServerVia.Typed);
  };
  const use = (server: FoundLocalServer): void => {
    setUrl(server.url);
    if (server.needsKey) keyField.current?.focus();
    else send(server.url, LocalServerVia.Found);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-local-server-form>
      {found.length > 0 && <FoundServers found={found} onUse={use} />}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={WORDS.addressLabel}
          placeholder={WORDS.addressPlaceholder}
          autoComplete="off"
          spellCheck={false}
          value={url}
          disabled={busy}
          onChange={(event) => setUrl(event.target.value)}
          className={`${FIELD} w-64 flex-1`}
        />
        <input
          ref={keyField}
          type="password"
          aria-label={WORDS.keyLabel}
          placeholder={WORDS.keyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          value={key}
          disabled={busy}
          onChange={(event) => setKey(event.target.value)}
          className={`${FIELD} w-52`}
        />
        <Button type="submit" variant="default" disabled={busy || !url.trim()}>
          {busy ? WORDS.connecting : WORDS.connect}
        </Button>
        {onCancel && (
          <Button disabled={busy} onClick={onCancel}>
            {WORDS.cancel}
          </Button>
        )}
      </div>
    </form>
  );
}

/** A saved server that asks for a key: the key alone, its address kept. */
function KeyEntry({ busy, onSave }: { busy: boolean; onSave: (key: string) => void }): JSX.Element {
  const [key, setKey] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!key.trim() || busy) return;
    const pasted = key;
    setKey("");
    onSave(pasted);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-local-server-key>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          aria-label={WORDS.keyLabel}
          placeholder={WORDS.keyLabel}
          autoComplete="off"
          spellCheck={false}
          value={key}
          disabled={busy}
          onChange={(event) => setKey(event.target.value)}
          className={`${FIELD} w-64`}
        />
        <Button type="submit" variant="default" disabled={busy || !key.trim()}>
          {busy ? WORDS.connecting : WORDS.saveKey}
        </Button>
      </div>
    </form>
  );
}

const PRESET_CONTEXTS = [
  { label: "32K", value: 32_768 },
  { label: "64K", value: 65_536 },
  { label: "128K", value: 131_072 },
  { label: "200K", value: 200_000 },
  { label: "1M", value: 1_048_576 },
];

function ModelConfigDialog({
  model,
  onClose,
  onSave,
}: {
  model: EngineDescriptor["models"][number];
  onClose: () => void;
  onSave: (override: ModelOverride | null) => Promise<void>;
}): JSX.Element {
  const [contextWindow, setContextWindow] = useState(String(model.contextWindow || 131072));
  const [supportsVision, setSupportsVision] = useState(Boolean(model.supportsVision));
  const [supportsTools, setSupportsTools] = useState(model.supportsTools !== false);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const parsed = Number.parseInt(contextWindow, 10);
      await onSave({
        contextWindow: Number.isFinite(parsed) && parsed > 0 ? parsed : 131072,
        supportsVision,
        supportsTools,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const reset = async (): Promise<void> => {
    setSaving(true);
    try {
      await onSave(null);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogSurface
      title={t("Configure: {name}", { name: model.label })}
      description={t("Custom context length and vision for this model on your local server. Saved to models.json.")}
      onDismiss={onClose}
      size="md"
    >
      <div className="flex flex-col gap-4 py-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-foreground">{t("Context window (tokens)")}</label>
          <input
            type="number"
            min={1024}
            max={2097152}
            step={1024}
            value={contextWindow}
            onChange={(e) => setContextWindow(e.target.value)}
            className="h-8 rounded border border-input bg-field px-2.5 font-mono text-xs text-foreground focus:outline-none focus:border-accent-ink"
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {PRESET_CONTEXTS.map((preset) => (
              <button
                type="button"
                key={preset.value}
                onClick={() => setContextWindow(String(preset.value))}
                className={`rounded border px-2 py-0.5 text-micro transition-colors ${
                  contextWindow === String(preset.value)
                    ? "border-accent bg-accent/10 font-medium text-accent"
                    : "border-input bg-surface-raised text-muted-foreground hover:text-foreground"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2.5 pt-2 border-t border-line">
          <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground select-none">
            <Checkbox checked={supportsVision} onChange={(e) => setSupportsVision(e.target.checked)} />
            <span>{t("Supports vision (image understanding)")}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground select-none">
            <Checkbox checked={supportsTools} onChange={(e) => setSupportsTools(e.target.checked)} />
            <span>{t("Supports tool calling (file editing, terminal)")}</span>
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 pt-4 border-t border-line">
          <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>
            {t("Reset to default")}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              {t("Cancel")}
            </Button>
            <Button variant="default" size="sm" onClick={save} disabled={saving}>
              {saving ? t("Saving…") : t("Save")}
            </Button>
          </div>
        </div>
      </div>
    </DialogSurface>
  );
}

/** The saved server's models: each with its context, and whether it sees or cannot build. */
function ServerModels({
  models,
  onConfigure,
}: {
  models: EngineDescriptor["models"];
  onConfigure: (model: EngineDescriptor["models"][number]) => void;
}): JSX.Element | null {
  if (models.length === 0) return null;
  return (
    <ul
      aria-label={WORDS.models}
      className="mt-1 -mx-2.5 flex flex-col border-t border-line pt-2"
      data-local-server-models
      data-analytics-mask
    >
      {models.map((model) => (
        <li
          key={model.id}
          className="group flex min-h-8 flex-wrap items-center justify-between gap-x-2.5 px-2.5 py-1.5 rounded-md hover:bg-surface-raised cursor-pointer transition-colors"
          onClick={() => onConfigure(model)}
          title={t("Click to configure context window and vision")}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5">
            <span className="min-w-0 break-all font-mono text-xs text-ink">{model.label}</span>
            <span className={`text-micro ${model.supportsTools ? "text-muted-foreground" : "text-orange"}`}>
              {modelDetails(model)}
            </span>
          </div>
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 p-1 text-ink-3 hover:text-ink transition-opacity rounded"
            aria-label={t("Configure")}
            onClick={(e) => {
              e.stopPropagation();
              onConfigure(model);
            }}
          >
            <Icon name="settings" size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}
/** Connect and disconnect: each refreshes the engines, and a refusal keeps why. */
function useServerActions(onEnginesRefresh: () => Promise<void> | void) {
  const { run, error } = useRun();
  const [connecting, setConnecting] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const connect = (url: string, key: string, via: LocalServerVia, done: () => void): Promise<void> =>
    run(async () => {
      setConnecting(true);
      const attempt = { via, hasKey: key.trim() !== "" };
      const startedAt = reportClock();
      try {
        const result = await window.studio.localServerConnect(url, key.trim() || undefined).catch((err: unknown) => {
          reportLocalServerConnect(attempt, null, startedAt);
          throw err;
        });
        reportLocalServerConnect(attempt, result, startedAt);
        setRefusal(result.ok ? null : result);
        if (result.ok) done();
        await onEnginesRefresh();
      } finally {
        setConnecting(false);
      }
    });
  const disconnect = (done: () => void): Promise<void> =>
    run(async () => {
      setRefusal(null);
      await window.studio.localServerForget();
      done();
      await onEnginesRefresh();
    });
  return { connecting, refusal, error, run, connect, disconnect, dismiss: () => setRefusal(null) };
}

export function LocalServerRow({
  engine,
  onEnginesRefresh,
}: {
  engine: EngineDescriptor;
  onEnginesRefresh: () => Promise<void> | void;
}): JSX.Element {
  const actions = useServerActions(onEnginesRefresh);
  const { checking, recheck } = useRecheck(EngineId.LocalServer, onEnginesRefresh);
  const [editing, setEditing] = useState(false);
  const [configModel, setConfigModel] = useState<EngineDescriptor["models"][number] | null>(null);
  const server = engine.server ?? null;
  const state = localServerRowState(engine, { connecting: actions.connecting });
  useRowViewed(EngineId.LocalServer, state, ProviderSurface.Settings, null);
  const view = localServerView(state, engine, server, {
    recheck: (pressed) => {
      reportProviderPress(EngineId.LocalServer, pressed, ProviderSurface.Settings);
      void actions.run(recheck);
    },
    change: () => setEditing(true),
    disconnect: () => void actions.disconnect(() => setEditing(false)),
  });
  const asksForAddress = editing || !server;
  const asksForKey = !asksForAddress && state === LocalServerRowState.NeedsKey;
  const problem = rowProblem(actions.error, actions.refusal);
  const hint = rowHint({ address: asksForAddress, key: asksForKey }, actions.refusal, server);
  return (
    <section aria-label={WORDS.name} className="settings-card gap-3" data-provider-row={engine.id}>
      <RowHeading
        words={ROW_WORDS}
        version={undefined}
        tone={checking ? RowTone.Busy : view.tone}
        status={checking ? METERED_PROVIDER_WORDS.checking : view.status}
        view={view}
      />
      {asksForAddress && (
        <AddressEntry
          initialUrl={server?.url ?? ""}
          busy={actions.connecting}
          askedForKey={isKeyRefusal(actions.refusal)}
          onConnect={(url, key, via) => void actions.connect(url, key, via, () => setEditing(false))}
          onCancel={
            editing
              ? () => {
                  actions.dismiss();
                  setEditing(false);
                }
              : null
          }
        />
      )}
      {asksForKey && server && (
        <KeyEntry
          busy={actions.connecting}
          onSave={(key) => void actions.connect(server.url, key, LocalServerVia.SavedKey, () => {})}
        />
      )}
      {state === LocalServerRowState.Connected && !editing && (
        <ServerModels models={engine.models} onConfigure={setConfigModel} />
      )}
      {configModel && (
        <ModelConfigDialog
          model={configModel}
          onClose={() => setConfigModel(null)}
          onSave={async (override) => {
            await window.studio.localServerSetModelOverride(configModel.id, override);
            setConfigModel(null);
            await onEnginesRefresh();
          }}
        />
      )}
      {problem && (
        <p role="alert" className="text-body-sm text-red">
          {problem}
        </p>
      )}
      {hint && <p className="text-body-sm text-muted-foreground">{hint}</p>}
    </section>
  );
}
