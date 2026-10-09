/**
 * Settings → Model Providers, the metered rows: OpenCode, which signs in to providers itself in
 * Studio's terminal, and OpenRouter, whose API key is pasted here. Each row keeps the shape of a
 * subscription's (`ModelsSection.tsx`): one status plate, one line, at most one visible action, an
 * Account menu once connected, and the picker's model list under it. The OpenRouter key goes
 * straight to main, which checks it with OpenRouter and keeps it in the OS secret store; it is
 * never shown again, and the field forgets it the moment it is sent.
 */
import { type JSX, lazy, Suspense, useEffect, useRef, useState } from "react";
import { type EngineStatus, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineId } from "../../shared/providers.ts";
import { TerminalKind, type TerminalSession } from "../../shared/terminal.ts";
import { useCliInstall } from "../cli-install.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { Pending } from "../ui/Pending.tsx";
import { METERED_PROVIDER_WORDS, problemWords } from "../words.ts";
import { OpenCodeRowState, openCodeRowState } from "./opencode-row.ts";
import { PickerModels } from "./PickerModels.tsx";
import { type ProviderWords, RowHeading, RowTone, type RowView } from "./provider-row.tsx";
import { useSignInTerminal } from "./use-sign-in-terminal.ts";

const WORDS = METERED_PROVIDER_WORDS;
const TerminalView = lazy(() => import("./TerminalView.tsx"));

/** What the metered rows need: the engines, and a way to read them again. */
export type MeteredProviderProps = { engines: EngineDescriptor[]; onEnginesRefresh: () => Promise<void> | void };

/** A row's actions: each clears the last error and keeps its own. */
function useRun(): { run: (action: () => Promise<unknown>) => Promise<void>; error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(problemWords(err));
    }
  };
  return { run, error };
}

/** "Check connection" first, then the row's own items, in the Account menu of a connected row. */
function AccountMenu({
  name,
  onCheck,
  children,
}: {
  name: string;
  onCheck: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={`${name} account`}>
          {WORDS.account}
          <Icon name="chevron-down" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={onCheck}>
          <ItemWords title={WORDS.checkConnection} line={WORDS.checkConnectionLine} />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A menu item's word and, under it, its quieter line. */
function ItemWords({ title, line }: { title: string; line: string }): JSX.Element {
  return (
    <span className="flex flex-col gap-0.5">
      <span>{title}</span>
      <span className="text-micro text-muted-foreground">{line}</span>
    </span>
  );
}

/** The row's card: its heading, the picker's models once connected, and its trouble. */
function ProviderCard({
  words,
  engine,
  view,
  checking,
  connected,
  problem,
  children,
}: {
  words: ProviderWords;
  engine: EngineDescriptor;
  view: RowView;
  checking: boolean;
  connected: boolean;
  problem: string | null;
  children?: JSX.Element | false;
}): JSX.Element {
  return (
    <section aria-label={words.name} className="settings-card gap-2" data-provider-row={engine.id}>
      <RowHeading
        words={words}
        version={engine.account?.cli.version}
        tone={checking ? RowTone.Busy : view.tone}
        status={checking ? WORDS.checking : view.status}
        view={view}
      />
      {children}
      {connected && <PickerModels engine={engine} name={words.name} />}
      {problem && (
        <p role="alert" className="text-body-sm text-red">
          {problem}
        </p>
      )}
    </section>
  );
}

/** Recheck one engine (its models too), then read the engines again; the row says it is looking. */
function useRecheck(engineId: string, onEnginesRefresh: () => Promise<void> | void) {
  const [checking, setChecking] = useState(false);
  const recheck = async (): Promise<void> => {
    setChecking(true);
    try {
      await window.studio.recheckEngines(engineId);
      await onEnginesRefresh();
    } finally {
      setChecking(false);
    }
  };
  return { checking, recheck };
}

const OPEN_CODE_WORDS: ProviderWords = { name: WORDS.openCode.name, plans: "", guide: WORDS.openCode.guide };

/** What OpenCode's row can do: install, recheck, sign in to a provider or stop signing in, update. */
type OpenCodeActions = {
  install: () => void;
  recheck: () => void;
  signIn: () => void;
  cancelSignIn: () => void;
  /** Open the sign-in page OpenCode printed, when it printed one. */
  openSignInPage: (() => void) | null;
  update: () => void;
};

/** OpenCode's row by its state: installing, missing, signing in, free models only, connected or unreachable. */
function openCodeView(state: OpenCodeRowState, act: OpenCodeActions): RowView {
  switch (state) {
    case OpenCodeRowState.Installing:
      return { tone: RowTone.Busy, status: WORDS.installing, line: WORDS.openCode.installingLine, actions: null };
    case OpenCodeRowState.NotInstalled:
      return {
        tone: RowTone.Off,
        status: WORDS.notInstalled,
        line: WORDS.openCode.installLine,
        actions: (
          <>
            <Button variant="default" onClick={act.install}>
              {WORDS.openCode.install}
            </Button>
            <Button onClick={act.recheck}>{WORDS.checkAgain}</Button>
          </>
        ),
      };
    case OpenCodeRowState.SigningIn:
      return openCodeSigningInView(act);
    case OpenCodeRowState.SignedOut:
      return {
        tone: RowTone.Off,
        status: WORDS.notConnected,
        line: WORDS.openCode.signInLine,
        actions: (
          <Button variant="default" onClick={act.signIn}>
            {WORDS.openCode.signIn}
          </Button>
        ),
      };
    case OpenCodeRowState.FreeOnly:
      return openCodeFreeOnlyView(act);
    case OpenCodeRowState.Connected:
      return openCodeConnectedView(act);
    default:
      return {
        tone: RowTone.Danger,
        status: WORDS.couldNotCheck,
        line: WORDS.openCode.unreachable,
        actions: <Button onClick={act.recheck}>{WORDS.tryAgain}</Button>,
      };
  }
}

/** OpenCode's own sign-in runs in the row's terminal, below: finish it there, or stop it. */
function openCodeSigningInView(act: OpenCodeActions): RowView {
  return {
    tone: RowTone.Busy,
    status: WORDS.signingIn,
    line: WORDS.openCode.signingIn,
    actions: (
      <>
        {act.openSignInPage && (
          <Button variant="default" onClick={act.openSignInPage}>
            {WORDS.openCode.openSignInPage}
          </Button>
        )}
        <Button onClick={act.cancelSignIn}>{WORDS.openCode.cancelSignIn}</Button>
      </>
    ),
  };
}

/** The sign-in's terminal inside the row, so Settings stays open while OpenCode asks its questions. */
function SignInTerminal({ session, onError }: { session: TerminalSession; onError: (error: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // The row may sit below the fold: bring the sign-in's questions into view once it starts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per sign-in session
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [session.id]);
  return (
    <div
      ref={box}
      data-keeps-escape
      data-sign-in-terminal
      className="h-[26rem] min-h-0 overflow-hidden rounded-lg border border-line bg-base pt-2"
    >
      <Suspense fallback={<Pending label={WORDS.signingIn} className="px-3 text-xs" />}>
        <TerminalView session={session} visible onError={onError} />
      </Suspense>
    </div>
  );
}

/** No provider signed in: OpenCode's free models run, and Sign in comes first. */
function openCodeFreeOnlyView(act: OpenCodeActions): RowView {
  return {
    tone: RowTone.Warning,
    status: WORDS.openCode.freeOnly,
    line: WORDS.openCode.freeOnlyLine,
    actions: (
      <>
        <Button variant="default" onClick={act.signIn}>
          {WORDS.openCode.signIn}
        </Button>
        <AccountMenu name={WORDS.openCode.name} onCheck={act.recheck}>
          <DropdownMenuItem onSelect={act.update}>{WORDS.openCode.update}</DropdownMenuItem>
        </AccountMenu>
      </>
    ),
  };
}

/** A provider signed in: billed by each one, and another can be added. */
function openCodeConnectedView(act: OpenCodeActions): RowView {
  return {
    tone: RowTone.Connected,
    status: WORDS.connected,
    line: WORDS.openCode.connectedLine,
    actions: (
      <AccountMenu name={WORDS.openCode.name} onCheck={act.recheck}>
        <>
          <DropdownMenuItem onSelect={act.signIn}>
            <ItemWords title={WORDS.openCode.addProvider} line={WORDS.openCode.addProviderLine} />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={act.update}>{WORDS.openCode.update}</DropdownMenuItem>
        </>
      </AccountMenu>
    ),
  };
}

function OpenCodeRow({
  engine,
  onEnginesRefresh,
}: { engine: EngineDescriptor } & Pick<MeteredProviderProps, "onEnginesRefresh">) {
  const install = useCliInstall(EngineId.OpenCode);
  const { run, error } = useRun();
  const { checking, recheck } = useRecheck(EngineId.OpenCode, onEnginesRefresh);
  // The sign-in runs in this row's terminal; when it exits, the host rechecks OpenCode's models.
  const terminal = useSignInTerminal(TerminalKind.OpenCodeLogin);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const ready = engine.status.code === EngineStatusCode.Ready;
  const state = openCodeRowState(engine, { installing: install.installing, signingIn: Boolean(terminal) });
  const signIn = (): void =>
    void run(async () => {
      setTerminalError(null);
      const started = await window.studio.openCodeSignIn();
      if (!started.started) await recheck();
    });
  const cancelSignIn = (): void => {
    if (terminal) void run(() => window.studio.terminalStop(terminal.id));
  };
  const view = openCodeView(state, {
    install: () => void install.install(),
    recheck: () => void run(recheck),
    signIn,
    cancelSignIn,
    openSignInPage: terminal?.signInPage ? () => void run(() => window.studio.terminalOpenLink(terminal.id)) : null,
    update: () => void install.update(),
  });
  return (
    <ProviderCard
      words={OPEN_CODE_WORDS}
      engine={engine}
      view={view}
      checking={checking}
      connected={ready && !install.installing}
      problem={error ?? terminalError ?? install.problem}
    >
      {terminal && <SignInTerminal session={terminal} onError={setTerminalError} />}
    </ProviderCard>
  );
}

const OPEN_ROUTER_WORDS: ProviderWords = { name: WORDS.openRouter.name, plans: "", guide: WORDS.openRouter.keysUrl };

/** The key field: paste, save (checked by OpenRouter first), get a key, or cancel a replacement. */
function KeyEntry({
  saving,
  onSave,
  onCancel,
}: {
  saving: boolean;
  onSave: (key: string) => Promise<void>;
  onCancel: (() => void) | null;
}): JSX.Element {
  const [key, setKey] = useState("");
  const save = async (): Promise<void> => {
    const pasted = key;
    // The field forgets the key the moment it is sent.
    setKey("");
    await onSave(pasted);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="password"
        aria-label={WORDS.openRouter.keyLabel}
        placeholder={WORDS.openRouter.keyPlaceholder}
        autoComplete="off"
        spellCheck={false}
        value={key}
        disabled={saving}
        onChange={(event) => setKey(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && key.trim()) void save();
        }}
        className="h-8 w-64 rounded-control border border-input bg-field px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-accent-ink"
      />
      <Button variant="default" disabled={saving || !key.trim()} onClick={() => void save()}>
        {saving ? WORDS.saving : WORDS.openRouter.save}
      </Button>
      <Button onClick={() => void window.studio.openUrl(WORDS.openRouter.keysUrl)}>{WORDS.openRouter.getKey}</Button>
      {onCancel && <Button onClick={onCancel}>{WORDS.openRouter.cancel}</Button>}
    </div>
  );
}

/** OpenRouter's row by its state: connected, waiting for a key, or unable to check. */
function openRouterView(
  status: EngineStatus,
  act: { recheck: () => void; replace: () => void; remove: () => void },
): RowView {
  if (status.code === EngineStatusCode.Ready)
    return {
      tone: RowTone.Connected,
      status: WORDS.connected,
      line: WORDS.openRouter.connectedLine,
      actions: (
        <AccountMenu name={WORDS.openRouter.name} onCheck={act.recheck}>
          <>
            <DropdownMenuItem onSelect={act.replace}>
              <ItemWords title={WORDS.openRouter.replace} line={WORDS.openRouter.replaceLine} />
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={act.remove}>{WORDS.openRouter.remove}</DropdownMenuItem>
          </>
        </AccountMenu>
      ),
    };
  if (status.code === EngineStatusCode.NeedsLogin)
    return { tone: RowTone.Off, status: WORDS.notConnected, line: WORDS.openRouter.notConnectedLine, actions: null };
  return {
    tone: RowTone.Danger,
    status: WORDS.couldNotCheck,
    line: status.detail,
    actions: <Button onClick={act.recheck}>{WORDS.tryAgain}</Button>,
  };
}

function OpenRouterRow({
  engine,
  onEnginesRefresh,
}: { engine: EngineDescriptor } & Pick<MeteredProviderProps, "onEnginesRefresh">) {
  const { run, error } = useRun();
  const { checking, recheck } = useRecheck(EngineId.OpenRouter, onEnginesRefresh);
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState(false);
  const ready = engine.status.code === EngineStatusCode.Ready;
  const save = (key: string): Promise<void> =>
    run(async () => {
      setSaving(true);
      try {
        const status = await window.studio.openRouterKeySave(key);
        const accepted = status.code === EngineStatusCode.Ready;
        setRefused(!accepted);
        if (accepted) setReplacing(false);
        await onEnginesRefresh();
      } finally {
        setSaving(false);
      }
    });
  const view = openRouterView(engine.status, {
    recheck: () => void run(recheck),
    replace: () => setReplacing(true),
    remove: () =>
      void run(async () => {
        await window.studio.openRouterKeyClear();
        await onEnginesRefresh();
      }),
  });
  const asksForKey = replacing || engine.status.code === EngineStatusCode.NeedsLogin;
  return (
    <ProviderCard
      words={OPEN_ROUTER_WORDS}
      engine={engine}
      view={view}
      checking={checking}
      connected={ready && !replacing}
      problem={error ?? (refused ? WORDS.openRouter.refused : null)}
    >
      {asksForKey && <KeyEntry saving={saving} onSave={save} onCancel={replacing ? () => setReplacing(false) : null} />}
    </ProviderCard>
  );
}

/** The metered rows, under the subscriptions: each only when its engine is registered. */
export function MeteredProviderRows({ engines, onEnginesRefresh }: MeteredProviderProps): JSX.Element {
  const openCode = engines.find((engine) => engine.id === EngineId.OpenCode);
  const openRouter = engines.find((engine) => engine.id === EngineId.OpenRouter);
  return (
    <>
      {openCode && <OpenCodeRow engine={openCode} onEnginesRefresh={onEnginesRefresh} />}
      {openRouter && <OpenRouterRow engine={openRouter} onEnginesRefresh={onEnginesRefresh} />}
    </>
  );
}
