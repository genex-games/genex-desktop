/**
 * Settings → Model Providers. One row per subscription, then the metered providers
 * (`MeteredProviders.tsx`): name and CLI version, one status plate, one line of context, and at most
 * one visible action. Account changes, a recheck (which also refreshes
 * the model list) and updating the CLI live in the row's Account menu; the model list speaks up
 * only while it loads or after a refresh failed (`catalog-note.ts`).
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { type ClaudeLoginState, isClaudeLoginActive } from "../../shared/claude-login.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineId } from "../../shared/providers.ts";
import { SUBSCRIPTION_ENGINES, useClaudeLogin, useSubscriptionAuth } from "../subscription-auth.ts";
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
import { CODE_FALLBACK_LABEL, useCodeFallback } from "../ui/SignInCard.tsx";
import { problemWords } from "../words.ts";
import { useCliInstall } from "../cli-install.ts";
import { SHOW_TERMINAL_EVENT } from "./terminal-events.ts";
import { PickerModels } from "./PickerModels.tsx";
import { CatalogNoteKind, catalogNote } from "./catalog-note.ts";
import { type ProviderWords, RowHeading, RowTone, type RowView } from "./provider-row.tsx";
import { MeteredProviderRows } from "./MeteredProviders.tsx";

const PROVIDERS: Record<string, ProviderWords> = {
  [EngineId.ClaudeCode]: {
    name: "Claude Code",
    plans: "Claude Pro or Max",
    guide: "https://code.claude.com/docs/en/setup",
  },
  [EngineId.Codex]: { name: "Codex", plans: "ChatGPT Plus or Pro", guide: "https://developers.openai.com/codex/cli/" },
};

/** "max" / "claude_max" → "Max plan". */
function planName(plan?: string): string | null {
  const word = plan
    ?.replace(/^claude[_-]?/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return word ? `${word.charAt(0).toUpperCase()}${word.slice(1)} plan` : null;
}

type Account = EngineDescriptor["account"];

/** The row's own actions: re-check, open the provider's guide, sign in or out, and the sign-in's steps. */
interface RowActions {
  run: (action: () => Promise<unknown>) => Promise<void>;
  recheck: () => Promise<void>;
  /** Asks the CLI for its model list again. */
  refreshModels: () => Promise<void>;
  openGuide: () => Promise<void>;
  signOut: () => Promise<void>;
  signIn: (options?: { separate?: boolean }) => Promise<void>;
}

/** The row's in-app install of its CLI (`useCliInstall`). */
type RowInstall = ReturnType<typeof useCliInstall>;

/** The CLI is missing, too old, or lacks Node.js: say which, and install or update it right here. */
function missingView(
  words: ProviderWords,
  cli: NonNullable<Account>["cli"] | undefined,
  act: RowActions,
  install: RowInstall,
): RowView {
  const outdated = cli?.state === CodingCliState.Incompatible;
  const runtime = cli?.state === CodingCliState.MissingRuntime;
  if (install.installing)
    return {
      tone: RowTone.Busy,
      status: outdated ? "Updating…" : "Installing…",
      line: `${outdated ? "Updating" : "Installing"} ${words.name}. This can take a minute.`,
      actions: null,
    };
  const actions = (
    <>
      <Button variant="default" onClick={() => void install.install()}>
        {outdated ? `Update ${words.name}` : `Install ${words.name}`}
      </Button>
      {install.problem && <Button onClick={() => void act.openGuide()}>Install guide</Button>}
      <Button onClick={() => void act.recheck()}>Check again</Button>
    </>
  );
  if (outdated)
    return { tone: RowTone.Warning, status: "Update needed", line: "This version is too old for Studio.", actions };
  if (runtime)
    return {
      tone: RowTone.Warning,
      status: "Needs Node.js",
      line: `This ${words.name} install needs Node.js, which isn't installed. Install the native version instead.`,
      actions,
    };
  return { tone: RowTone.Off, status: "Not installed", line: `Install it to use your ${words.plans} plan.`, actions };
}

/** Where a Claude sign-in is waiting, by its phase. */
const CLAUDE_SIGN_IN_LINE: Partial<Record<ClaudeLoginState["phase"], string>> = {
  code: "Paste the code the sign-in page shows you.",
  terminal: "Finish signing in in Studio's terminal.",
  verifying: "Checking the sign-in…",
};

/** A sign-in is under way: where to finish it and, for Claude, its terminal, page and cancel. */
function signingInView(
  engineId: string,
  login: ClaudeLoginState | null,
  act: RowActions,
  codeFallback: ReturnType<typeof useCodeFallback>,
): RowView {
  if (engineId === EngineId.Codex)
    return {
      tone: RowTone.Busy,
      status: "Signing in…",
      line: "Finish signing in in your browser.",
      actions: <Button onClick={() => void act.run(() => window.studio.codexLoginCancel())}>Cancel</Button>,
    };
  const phase = login?.phase;
  const waitingOnBrowser = phase === "code" && !codeFallback.pasting;
  const line = (!waitingOnBrowser && phase && CLAUDE_SIGN_IN_LINE[phase]) || "Finish signing in in your browser.";
  const actions = (
    <>
      {phase === "terminal" && (
        <Button onClick={() => window.dispatchEvent(new Event(SHOW_TERMINAL_EVENT))}>Show terminal</Button>
      )}
      {login?.hasBrowserUrl && (
        <Button onClick={() => void act.run(() => window.studio.claudeLoginOpenBrowser())}>Open sign-in page</Button>
      )}
      {waitingOnBrowser && <Button onClick={codeFallback.pasteCode}>{CODE_FALLBACK_LABEL}</Button>}
      <Button onClick={() => void act.run(() => window.studio.claudeLoginCancel())}>Cancel</Button>
    </>
  );
  return { tone: RowTone.Busy, status: "Signing in…", line, actions };
}

/** Where the connected account's login comes from. */
function loginSource(account: Account): string | null {
  if (account?.source === "system") return "Using your Terminal login";
  if (account?.source === "isolated") return "Signed in for Studio only";
  if (account?.source === "env" && account.variable) return `Set by ${account.variable}`;
  return null;
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

function AccountMenu({
  engineId,
  words,
  account,
  act,
  install,
}: {
  engineId: string;
  words: ProviderWords;
  account: Account;
  act: RowActions;
  install: RowInstall;
}): JSX.Element {
  const version = account?.cli.version;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={`${words.name} account`}>
          Account
          <Icon name="chevron-down" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem
          onSelect={() => {
            void act.recheck();
            void act.refreshModels();
          }}
        >
          <ItemWords title="Check connection" line="Also refreshes the model list" />
        </DropdownMenuItem>
        <DropdownMenuItem disabled={install.installing} onSelect={() => void install.update()}>
          {version ? <ItemWords title={`Update ${words.name}`} line={`You have ${version}`} /> : `Update ${words.name}`}
        </DropdownMenuItem>
        {account?.source !== "env" && <DropdownMenuSeparator />}
        {account?.source !== "env" && (
          <DropdownMenuItem
            onSelect={() =>
              void act.run(() => act.signIn(engineId === EngineId.Codex ? undefined : { separate: true }))
            }
          >
            <ItemWords title="Use a different account…" line="Your Terminal login stays as it is" />
          </DropdownMenuItem>
        )}
        {account?.source === "isolated" && (
          <DropdownMenuItem onSelect={() => void act.signOut()}>
            {account.afterSignOut === "terminal" ? (
              <ItemWords title="Switch back to your Terminal login" line="Signs Studio out of this account" />
            ) : (
              "Sign out"
            )}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Why a provider needs signing in: an account set by the environment, an API key in the way, or none yet. */
function signInLine(words: ProviderWords, engine: EngineDescriptor): string {
  const account = engine.account;
  if (account?.source === "env" && account.variable) return `Check the account set by ${account.variable}.`;
  if (/api key/i.test(engine.status.detail))
    return `${words.name} is using an API key. Sign in to use your ${words.plans} plan.`;
  return `Use your ${words.plans} plan.`;
}

/** The row for a provider's state: missing, signing in, connected, needing sign-in, or unreachable. */
function rowView(row: {
  engineId: string;
  engine: EngineDescriptor;
  words: ProviderWords;
  cliMissing: boolean;
  signingIn: boolean;
  login: ClaudeLoginState | null;
  loginError: string | null | undefined;
  act: RowActions;
  install: RowInstall;
  codeFallback: ReturnType<typeof useCodeFallback>;
}): RowView {
  const { engineId, engine, words, act } = row;
  if (row.cliMissing) return missingView(words, engine.account?.cli, act, row.install);
  if (row.signingIn) return signingInView(engineId, row.login, act, row.codeFallback);
  if (engine.status.code === EngineStatusCode.Ready && row.install.installing)
    return {
      tone: RowTone.Busy,
      status: "Updating…",
      line: `Updating ${words.name}. This can take a minute.`,
      actions: null,
    };
  if (engine.status.code === EngineStatusCode.Ready)
    return {
      tone: RowTone.Connected,
      status: "Connected",
      line: [planName(engine.usage?.plan), loginSource(engine.account)].filter(Boolean).join(" · ") || null,
      actions: (
        <AccountMenu engineId={engineId} words={words} account={engine.account} act={act} install={row.install} />
      ),
    };
  if (engine.status.code === EngineStatusCode.NeedsLogin)
    return {
      tone: RowTone.Off,
      status: "Not connected",
      line: signInLine(words, engine),
      actions: (
        <Button variant="default" onClick={() => void act.run(() => act.signIn())}>
          {row.loginError ? "Try again" : "Sign in"}
        </Button>
      ),
    };
  return {
    tone: RowTone.Danger,
    status: "Couldn't check",
    line: `${words.name} didn't answer. Check your internet connection, then try again.`,
    actions: <Button onClick={() => void act.recheck()}>Try again</Button>,
  };
}

/** The Claude sign-in's code box, while the sign-in page is waiting for the code. */
function CodeEntry({
  login,
  act,
  code,
  setCode,
}: {
  login: ClaudeLoginState | null;
  act: RowActions;
  code: string;
  setCode: (code: string) => void;
}): JSX.Element {
  const submitCode = (): Promise<void> =>
    act.run(async () => {
      await window.studio.claudeLoginCode(code);
      setCode("");
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        aria-label="Code from the sign-in page"
        placeholder="Paste the code"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && code.trim()) void submitCode();
        }}
        className="h-8 w-52 rounded-control border border-input bg-field px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-accent-ink"
      />
      <Button variant="default" disabled={!code.trim()} onClick={() => void submitCode()}>
        Continue
      </Button>
      {login?.hasBrowserUrl && (
        <Button onClick={() => void act.run(() => window.studio.claudeLoginOpenBrowser())}>Open sign-in page</Button>
      )}
    </div>
  );
}

/** The row's own actions, each clearing the last action's error and keeping its own. */
function useRowActions(
  engineId: string,
  guide: string,
  refresh: () => Promise<unknown>,
  signIn: RowActions["signIn"],
): RowActions & { checking: boolean; actionError: string | null } {
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(problemWords(err));
    }
  };
  const recheck = (): Promise<void> =>
    run(async () => {
      setChecking(true);
      try {
        await refresh();
      } finally {
        setChecking(false);
      }
    });
  return {
    checking,
    actionError,
    run,
    recheck,
    refreshModels: () => run(() => window.studio.refreshModels(engineId)),
    openGuide: () => run(() => window.studio.openUrl(guide)),
    signOut: () =>
      run(async () => {
        await window.studio.subscriptionForgetStudioLogin(engineId);
        await refresh();
      }),
    signIn,
  };
}

/** Whether the provider's CLI is missing or unusable (too old, or without its runtime). */
function cliMissingFor(engine: EngineDescriptor | undefined): boolean {
  const cli = engine?.account?.cli;
  const unusable = cli !== undefined && cli.state !== CodingCliState.Ready;
  return engine?.status.code === EngineStatusCode.NotInstalled || unusable;
}

/** Where the provider's sign-in stands: Claude's own login, whether one is under way, and its trouble. */
function signInState(
  engineId: string,
  login: ClaudeLoginState | null,
  waiting: boolean,
  error: string | null,
): { claudeLogin: ClaudeLoginState | null; signingIn: boolean; loginError: string | null | undefined } {
  const claudeLogin = engineId === EngineId.ClaudeCode ? login : null;
  const claudeActive = claudeLogin !== null && isClaudeLoginActive(claudeLogin);
  return {
    claudeLogin,
    signingIn: engineId === EngineId.Codex ? waiting : claudeActive,
    loginError: (claudeLogin?.phase === "failed" ? claudeLogin.error : undefined) ?? error,
  };
}

/**
 * A connected row's model list, said only when it needs saying: still loading, or a refresh that
 * failed, with Try again beside it. A failed CLI update adds its installation guide.
 */
function CatalogLine({
  engine,
  engineId,
  install,
  act,
}: {
  engine: EngineDescriptor;
  engineId: string;
  install: RowInstall;
  act: RowActions;
}): JSX.Element | null {
  const note = catalogNote(engine.catalog);
  if (!note && !install.problem) return null;
  const problem = note?.kind === CatalogNoteKind.Problem;
  return (
    <div className="flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground" data-model-catalog={engineId}>
      {problem && <Icon name="info" size={16} className="text-orange" />}
      {note && <span title={note.detail}>{note.text}</span>}
      {note?.retry && (
        <Button disabled={note.retrying} onClick={() => void act.refreshModels()}>
          {note.retrying ? "Trying again…" : "Try again"}
        </Button>
      )}
      {install.problem && <Button onClick={() => void act.openGuide()}>Installation guide</Button>}
    </div>
  );
}

function ProviderRow({
  engineId,
  engines,
  onEnginesRefresh,
}: { engineId: string } & ModelSettingsProps): JSX.Element | null {
  const { engine, waiting, error, signIn, refresh } = useSubscriptionAuth(engines, onEnginesRefresh, engineId);
  const login = useClaudeLogin(engineId);
  const cliMissing = cliMissingFor(engine);
  const words = PROVIDERS[engineId] ?? { name: engine?.label ?? "", plans: "subscription", guide: "" };
  const act = useRowActions(engineId, words.guide, refresh, signIn);
  const install = useCliInstall(engineId);
  const codeFallback = useCodeFallback(login?.phase);
  const [code, setCode] = useState("");

  // Coming back from installing the CLI in another app is the moment to look again.
  useEffect(() => {
    if (!cliMissing) return;
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [cliMissing, refresh]);

  if (!engine) return null;
  const { claudeLogin, signingIn, loginError } = signInState(engineId, login, waiting, error);
  const view = rowView({
    engineId,
    engine,
    words,
    cliMissing,
    signingIn,
    login: claudeLogin,
    loginError,
    act,
    install,
    codeFallback,
  });
  // Signed in with a working CLI: the model list belongs to the row, also while the CLI updates.
  const connected = !cliMissing && !signingIn && engine.status.code === EngineStatusCode.Ready;
  // A recheck keeps the row's line and actions in place; only the status says it is looking.
  const tone = act.checking ? RowTone.Busy : view.tone;
  const status = act.checking ? "Checking…" : view.status;
  // A sign-in error belongs to the Sign in button; it is noise once the row is about something else.
  const signInTrouble = !cliMissing && !signingIn && engine.status.code === EngineStatusCode.NeedsLogin;
  const problem = act.actionError ?? install.problem ?? (signInTrouble ? loginError : null);
  return (
    <section aria-label={words.name} className="settings-card gap-2">
      <RowHeading words={words} version={engine.account?.cli.version} tone={tone} status={status} view={view} />
      {/* The model catalog belongs to a connected account; a signed-out row keeps its one Sign in action. */}
      {connected && (
        <>
          <CatalogLine engine={engine} engineId={engineId} install={install} act={act} />
          <PickerModels engine={engine} name={words.name} />
        </>
      )}
      {signingIn && codeFallback.pasting && <CodeEntry login={claudeLogin} act={act} code={code} setCode={setCode} />}
      {problem && (
        <p role="alert" className="text-body-sm text-red">
          {problemWords(problem)}
        </p>
      )}
    </section>
  );
}

/** `onEnginesRefresh` settles once the engines are read again. */
export type ModelSettingsProps = { engines: EngineDescriptor[]; onEnginesRefresh: () => Promise<void> | void };

export function ModelProvidersSection({ engines, onEnginesRefresh }: ModelSettingsProps): JSX.Element {
  useEffect(() => {
    onEnginesRefresh();
  }, [onEnginesRefresh]);
  return (
    <div className="flex flex-col gap-3">
      {SUBSCRIPTION_ENGINES.map((id) => (
        <ProviderRow key={id} engineId={id} engines={engines} onEnginesRefresh={onEnginesRefresh} />
      ))}
      <MeteredProviderRows engines={engines} onEnginesRefresh={onEnginesRefresh} />
    </div>
  );
}
