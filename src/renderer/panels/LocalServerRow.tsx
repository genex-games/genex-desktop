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

/** The row's actions: check again, change the address, or disconnect. */
type RowActions = { recheck: () => void; change: () => void; disconnect: () => void };

/** The saved server's menu: Check connection, then Change address… and Disconnect. */
function ServerMenu({ act }: { act: RowActions }): JSX.Element {
  return (
    <AccountMenu name={WORDS.name} label={WORDS.menu} menuName={WORDS.menuName} onCheck={act.recheck}>
      <>
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
        {retry && <Button onClick={act.recheck}>{METERED_PROVIDER_WORDS.checkAgain}</Button>}
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
    <div role="group" aria-label={WORDS.found} className="flex flex-col gap-1" data-local-server-found>
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
      .then((servers) => live && setFound(servers))
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
  onConnect: (url: string, key: string) => void;
  onCancel: (() => void) | null;
}): JSX.Element {
  const [url, setUrl] = useState(initialUrl);
  const [key, setKey] = useState("");
  const keyField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (askedForKey && !busy) keyField.current?.focus();
  }, [askedForKey, busy]);
  const found = useFoundServers().filter((server) => server.url !== initialUrl);
  const send = (address: string): void => {
    const pasted = key;
    // The field forgets the key the moment it is sent.
    setKey("");
    onConnect(address, pasted);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (url.trim() && !busy) send(url);
  };
  const use = (server: FoundLocalServer): void => {
    setUrl(server.url);
    if (server.needsKey) keyField.current?.focus();
    else send(server.url);
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

/** The saved server's models: each with its context, and whether it sees or cannot build. */
function ServerModels({ models }: { models: EngineDescriptor["models"] }): JSX.Element | null {
  if (models.length === 0) return null;
  return (
    <ul
      aria-label={WORDS.models}
      className="mt-1 -mx-2.5 flex flex-col border-t border-line pt-2"
      data-local-server-models
    >
      {models.map((model) => (
        <li key={model.id} className="flex min-h-8 flex-wrap items-baseline gap-x-2.5 px-2.5 py-1">
          <span className="min-w-0 break-all font-mono text-xs text-ink">{model.label}</span>
          <span className={`text-micro ${model.supportsTools ? "text-muted-foreground" : "text-orange"}`}>
            {modelDetails(model)}
          </span>
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
  const connect = (url: string, key: string, done: () => void): Promise<void> =>
    run(async () => {
      setConnecting(true);
      try {
        const result = await window.studio.localServerConnect(url, key.trim() || undefined);
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
  const server = engine.server ?? null;
  const state = localServerRowState(engine, { connecting: actions.connecting });
  const view = localServerView(state, engine, server, {
    recheck: () => void actions.run(recheck),
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
          onConnect={(url, key) => void actions.connect(url, key, () => setEditing(false))}
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
        <KeyEntry busy={actions.connecting} onSave={(key) => void actions.connect(server.url, key, () => {})} />
      )}
      {state === LocalServerRowState.Connected && !editing && <ServerModels models={engine.models} />}
      {problem && (
        <p role="alert" className="text-body-sm text-red">
          {problem}
        </p>
      )}
      {hint && <p className="text-body-sm text-muted-foreground">{hint}</p>}
    </section>
  );
}
