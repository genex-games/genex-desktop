/**
 * Settings → Model Providers, the metered rows: OpenCode, which signs in to providers itself in
 * Studio's terminal, Grok Build, which signs in to the person's Grok account there the same way,
 * and OpenRouter, whose API key is pasted here. Each row keeps the shape of a
 * subscription's (`ModelsSection.tsx`): one status plate, one line, at most one visible action, an
 * Account menu once connected, and the picker's model list under it. The OpenRouter key goes
 * straight to main, which checks it with OpenRouter and keeps it in the OS secret store; it is
 * never shown again, and the field forgets it the moment it is sent.
 */
import { type JSX, lazy, Suspense, useEffect, useRef, useState } from "react";
import { type EngineStatus, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { t } from "../../shared/i18n.ts";
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
export function useRun(): { run: (action: () => Promise<unknown>) => Promise<void>; error: string | null } {
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

/**
 * "Check connection" first, then the row's own items, in the Account menu of a connected row; a
 * row that holds no account (a local server) names its menu by what it holds.
 */
export function AccountMenu({
  name,
  label = WORDS.account,
  menuName = t("{name} account", { name }),
  onCheck,
  children,
}: {
  name: string;
  label?: string;
  /** The trigger's accessible name. */
  menuName?: string;
  onCheck: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={menuName}>
          {label}
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
export function ItemWords({ title, line }: { title: string; line: string }): JSX.Element {
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
export function useRecheck(engineId: string, onEnginesRefresh: () => Promise<void> | void) {
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

/** What OpenCode's and Grok Build's rows can do: install, recheck, sign in or stop signing in, update. */
type CliRowActions = {
  install: () => void;
  recheck: () => void;
  signIn: () => void;
  cancelSignIn: () => void;
  /** Open the sign-in page the CLI printed, when it printed one. */
  openSignInPage: (() => void) | null;
  update: () => void;
};

/** What a row whose CLI signs in in its own terminal says: OpenCode's words, or Grok Build's. */
interface CliRowWords {
  card: ProviderWords;
  install: string;
  installLine: string;
  installingLine: string;
  signIn: string;
  signInLine: string;
  signingIn: string;
  openSignInPage: string;
  cancelSignIn: string;
  update: string;
  connectedLine: string;
  unreachable: string;
  /** The Account menu's item that signs in again: OpenCode adds a provider, Grok switches accounts. */
  again: { title: string; line: string };
  /** OpenCode's own free models running with no provider signed in; Grok Build has none. */
  freeOnly?: { status: string; line: string };
}

const OPEN_CODE_ROW: CliRowWords = {
  ...WORDS.openCode,
  card: { name: WORDS.openCode.name, plans: "", guide: WORDS.openCode.guide },
  again: { title: WORDS.openCode.addProvider, line: WORDS.openCode.addProviderLine },
  freeOnly: { status: WORDS.openCode.freeOnly, line: WORDS.openCode.freeOnlyLine },
};

const GROK_ROW: CliRowWords = {
  ...WORDS.grok,
  card: { name: WORDS.grok.name, plans: "", guide: WORDS.grok.guide },
  again: { title: WORDS.grok.signInAgain, line: WORDS.grok.signInAgainLine },
};

/** The row by its state: installing, missing, signing in, free models only, connected or unreachable. */
function cliRowView(state: OpenCodeRowState, act: CliRowActions, words: CliRowWords): RowView {
  switch (state) {
    case OpenCodeRowState.Installing:
      return { tone: RowTone.Busy, status: WORDS.installing, line: words.installingLine, actions: null };
    case OpenCodeRowState.NotInstalled:
      return {
        tone: RowTone.Off,
        status: WORDS.notInstalled,
        line: words.installLine,
        actions: (
          <>
            <Button variant="default" onClick={act.install}>
              {words.install}
            </Button>
            <Button onClick={act.recheck}>{WORDS.checkAgain}</Button>
          </>
        ),
      };
    case OpenCodeRowState.SigningIn:
      return signingInView(act, words);
    case OpenCodeRowState.SignedOut:
      return {
        tone: RowTone.Off,
        status: WORDS.notConnected,
        line: words.signInLine,
        actions: (
          <Button variant="default" onClick={act.signIn}>
            {words.signIn}
          </Button>
        ),
      };
    case OpenCodeRowState.FreeOnly:
      return words.freeOnly ? freeOnlyView(act, words, words.freeOnly) : connectedView(act, words);
    case OpenCodeRowState.Connected:
      return connectedView(act, words);
    default:
      return {
        tone: RowTone.Danger,
        status: WORDS.couldNotCheck,
        line: words.unreachable,
        actions: <Button onClick={act.recheck}>{WORDS.tryAgain}</Button>,
      };
  }
}

/** The CLI's own sign-in runs in the row's terminal, below: finish it there, or stop it. */
function signingInView(act: CliRowActions, words: CliRowWords): RowView {
  return {
    tone: RowTone.Busy,
    status: WORDS.signingIn,
    line: words.signingIn,
    actions: (
      <>
        {act.openSignInPage && (
          <Button variant="default" onClick={act.openSignInPage}>
            {words.openSignInPage}
          </Button>
        )}
        <Button onClick={act.cancelSignIn}>{words.cancelSignIn}</Button>
      </>
    ),
  };
}

/** The sign-in's terminal inside the row, so Settings stays open while the CLI asks its questions. */
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
      <Suspense fallback={<Pending label={WORDS.signingIn} className="px-3 py-2" working />}>
        <TerminalView session={session} visible onError={onError} />
      </Suspense>
    </div>
  );
}

/** No provider signed in: OpenCode's free models run, and Sign in comes first. */
function freeOnlyView(act: CliRowActions, words: CliRowWords, free: { status: string; line: string }): RowView {
  return {
    tone: RowTone.Warning,
    status: free.status,
    line: free.line,
    actions: (
      <>
        <Button variant="default" onClick={act.signIn}>
          {words.signIn}
        </Button>
        <AccountMenu name={words.card.name} onCheck={act.recheck}>
          <DropdownMenuItem onSelect={act.update}>{words.update}</DropdownMenuItem>
        </AccountMenu>
      </>
    ),
  };
}

/** Signed in: OpenCode is billed by each provider and can add one; Grok Build can switch accounts. */
function connectedView(act: CliRowActions, words: CliRowWords): RowView {
  return {
    tone: RowTone.Connected,
    status: WORDS.connected,
    line: words.connectedLine,
    actions: (
      <AccountMenu name={words.card.name} onCheck={act.recheck}>
        <>
          <DropdownMenuItem onSelect={act.signIn}>
            <ItemWords title={words.again.title} line={words.again.line} />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={act.update}>{words.update}</DropdownMenuItem>
        </>
      </AccountMenu>
    ),
  };
}

/** A CLI that signs in in its own terminal: which one, how its sign-in starts, and what its row says. */
type CliRowProps = { engine: EngineDescriptor } & Pick<MeteredProviderProps, "onEnginesRefresh"> & {
    engineId: typeof EngineId.OpenCode | typeof EngineId.Grok;
    terminalKind: typeof TerminalKind.OpenCodeLogin | typeof TerminalKind.GrokLogin;
    startSignIn: () => Promise<{ started: boolean }>;
    words: CliRowWords;
  };

function CliSignInRow({ engine, onEnginesRefresh, engineId, terminalKind, startSignIn, words }: CliRowProps) {
  const install = useCliInstall(engineId);
  const { run, error } = useRun();
  const { checking, recheck } = useRecheck(engineId, onEnginesRefresh);
  // The sign-in runs in this row's terminal; when it exits, the host asks the CLI again.
  const terminal = useSignInTerminal(terminalKind);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const ready = engine.status.code === EngineStatusCode.Ready;
  const state = openCodeRowState(engine, { installing: install.installing, signingIn: Boolean(terminal) });
  const signIn = (): void =>
    void run(async () => {
      setTerminalError(null);
      const started = await startSignIn();
      if (!started.started) await recheck();
    });
  const cancelSignIn = (): void => {
    if (terminal) void run(() => window.studio.terminalStop(terminal.id));
  };
  const view = cliRowView(
    state,
    {
      install: () => void install.install(),
      recheck: () => void run(recheck),
      signIn,
      cancelSignIn,
      openSignInPage: terminal?.signInPage ? () => void run(() => window.studio.terminalOpenLink(terminal.id)) : null,
      update: () => void install.update(),
    },
    words,
  );
  return (
    <ProviderCard
      words={words.card}
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
  const grok = engines.find((engine) => engine.id === EngineId.Grok);
  const openRouter = engines.find((engine) => engine.id === EngineId.OpenRouter);
  return (
    <>
      {openCode && (
        <CliSignInRow
          engine={openCode}
          onEnginesRefresh={onEnginesRefresh}
          engineId={EngineId.OpenCode}
          terminalKind={TerminalKind.OpenCodeLogin}
          startSignIn={() => window.studio.openCodeSignIn()}
          words={OPEN_CODE_ROW}
        />
      )}
      {grok && (
        <CliSignInRow
          engine={grok}
          onEnginesRefresh={onEnginesRefresh}
          engineId={EngineId.Grok}
          terminalKind={TerminalKind.GrokLogin}
          startSignIn={() => window.studio.grokSignIn()}
          words={GROK_ROW}
        />
      )}
      {openRouter && <OpenRouterRow engine={openRouter} onEnginesRefresh={onEnginesRefresh} />}
    </>
  );
}
