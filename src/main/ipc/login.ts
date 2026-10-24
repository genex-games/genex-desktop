/**
 * Subscription sign-in: both providers sign in inside the app, each through its own controller,
 * and forgetting the studio's own account never touches the user's own ~/.claude or ~/.codex.
 */
import fs from "node:fs/promises";
import { UiEvent } from "../../shared/ui-events.ts";
import { t } from "../../shared/i18n.ts";
import { runCommand } from "../../substrate/engines/claude-cli.ts";
import { CODEX_STUDIO_AUTH_ARGS, codexSubscriptionEnv } from "../../substrate/engines/codex-cli.ts";
import { requireCodingCli } from "../../substrate/engines/external-cli.ts";
import type { ClaudeLoginController } from "../claude-login.ts";
import type { CodexLoginController } from "../codex-login.ts";
import type { CursorLogin, OpenCodeLogin, SubscriptionEngine } from "../login-controllers.ts";
import type { IpcHandle } from "./registrar.ts";
import { EngineId } from "../../shared/providers.ts";
import { LoginSource } from "../../shared/engine-descriptor.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { NEW_ACCOUNT, type SubscriptionAccountView } from "../../shared/subscription-accounts.ts";
import { AccountId } from "../../substrate/engines/subscription-accounts.ts";

/** How long `codex logout` may take before forgetting the studio's sign-in gives up. */
const CODEX_LOGOUT_TIMEOUT_MS = 8 * SECOND_MS;

/**
 * Why a sign-in or connection change from the renderer is refused. The functions are words the
 * person reads on the sign-in card; `unknownEngine` and `unknownMethod` answer only a malformed call
 * from our own renderer.
 */
const MESSAGE = {
  busy: () => t("Finish or stop the active work before changing the ChatGPT connection."),
  changeInProgress: () => t("A ChatGPT connection change is already in progress."),
  unknownEngine: (id: string) => `unknown subscription engine: ${id}`,
  unknownMethod: "Unknown sign-in method",
  codexUnavailable: () => t("Codex is unavailable"),
  disconnectFailed: () => t("Codex could not disconnect. Please try again."),
  unknownAccount: () => t("Unknown account"),
  terminalSignOut: () => t("Sign out of the Terminal login in Terminal."),
  cursorUnavailable: () => t("Cursor is unavailable"),
} as const;

/** What signing Cursor out needs from its engine. */
export interface CursorAccount {
  signOut(): Promise<void>;
  status(): Promise<import("../../shared/engine-descriptor.ts").EngineStatus>;
}

export interface LoginIpcDeps {
  claudeLogin: Pick<ClaudeLoginController, "start" | "snapshot" | "submitCode" | "openBrowser" | "cancel">;
  codexLogin: Pick<CodexLoginController, "start" | "snapshot" | "cancel" | "dismiss" | "openBrowser">;
  openCodeLogin: OpenCodeLogin;
  cursorLogin: CursorLogin;
  /** The Cursor engine, to sign it out; null while none is registered. */
  cursor(): CursorAccount | null;
  subscription(id: string): SubscriptionEngine | null;
  /** A run is being held awake for, or a user turn is in flight: the ChatGPT account must not change under it. */
  busy(): boolean;
  pushUiEvent(event: UiEvent): void;
  requireCli?: typeof requireCodingCli;
  run?: typeof runCommand;
}

export function registerLoginIpc(
  handle: IpcHandle,
  {
    claudeLogin,
    codexLogin,
    openCodeLogin,
    cursorLogin,
    cursor,
    subscription,
    busy,
    pushUiEvent,
    requireCli = requireCodingCli,
    run = runCommand,
  }: LoginIpcDeps,
): void {
  let changingCodexAccount = false;
  async function changeCodexAccount<T>(change: () => Promise<T>): Promise<T> {
    if (busy()) {
      throw new Error(MESSAGE.busy());
    }
    if (changingCodexAccount) throw new Error(MESSAGE.changeInProgress());
    changingCodexAccount = true;
    try {
      return await change();
    } finally {
      changingCodexAccount = false;
    }
  }

  // Both subscriptions sign in inside the app now: their own CLI, an app-owned profile, and a
  // embedded PTY when a Claude CLI cannot be driven from a pipe.
  // Neither renderer controls executable paths or shell commands.
  handle("studio:subscription.signin", async (payload) => {
    const id = payload?.engine ?? EngineId.ClaudeCode;
    const engine = subscription(id);
    if (!engine) throw new Error(MESSAGE.unknownEngine(id));
    if (id === EngineId.Codex) {
      return changeCodexAccount(async () => {
        const state = await codexLogin.start(await codexSignInHome(engine, payload?.account));
        return { started: state.phase !== "failed", error: state.error };
      });
    }
    // The Terminal login signs in where the CLI keeps its own: no config folder named.
    if (payload?.account === AccountId.Terminal) return claudeLogin.start(null);
    if (payload?.account) return claudeLogin.start(await accountSignInHome(engine, payload.account));
    if (payload?.separate) return claudeLogin.start(engine.engineHome);
    return claudeLogin.start(claudeLoginHome(await engine.resolveLogin()));
  });

  // The Claude sign-in the card drives: what phase it is in, the code the browser showed, and
  // the link again for a browser that never opened. The URL itself stays in main.
  handle("studio:claude-login.state", async () => claudeLogin.snapshot());
  handle("studio:claude-login.code", async (payload) => claudeLogin.submitCode(String(payload?.code ?? "")));
  handle("studio:claude-login.browser", async () => {
    await claudeLogin.openBrowser();
    return true;
  });
  handle("studio:claude-login.cancel", async () => {
    await claudeLogin.cancel();
    return true;
  });

  // OpenCode's own sign-in in the terminal: it changes no account a run is using, so it is never refused.
  handle("studio:opencode.signin", async () => openCodeLogin.start());

  // Cursor's own sign-in in its Settings row's terminal, and its sign-out: the CLI forgets the
  // account it keeps, which a turn already running keeps until it ends.
  handle("studio:cursor.signin", async () => cursorLogin.start());
  handle("studio:cursor.signout", async () => {
    const engine = cursor();
    if (!engine) throw new Error(MESSAGE.cursorUnavailable());
    await engine.signOut();
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: { engine: EngineId.Cursor } });
    return engine.status();
  });

  handle("studio:codex-login.state", async () => codexLogin.snapshot());
  handle("studio:codex-login.cancel", async () => {
    await codexLogin.cancel();
    return codexLogin.snapshot();
  });
  handle("studio:codex-login.dismiss", async () => {
    await codexLogin.dismiss();
    return true;
  });
  handle("studio:codex-login.browser", async () => {
    await codexLogin.openBrowser();
    return true;
  });
  handle("studio:codex-login.retry", async (payload) => {
    if (payload?.method !== "browser" && payload?.method !== "device") throw new Error(MESSAGE.unknownMethod);
    const method = payload.method;
    return changeCodexAccount(async () => {
      await codexLogin.cancel();
      const engine = subscription(EngineId.Codex);
      if (!engine) throw new Error(MESSAGE.codexUnavailable());
      return codexLogin.start(await codexSignInHome(engine, undefined), method);
    });
  });

  registerAccountIpc(handle, { codexLogin, subscription, pushUiEvent, requireCli, run, changeCodexAccount });
}

/**
 * A subscription's accounts: listing them, switching which one runs, and signing Studio out of one
 * of its own. Codex's account never changes under work in flight (`changeCodexAccount`).
 */
function registerAccountIpc(
  handle: IpcHandle,
  {
    codexLogin,
    subscription,
    pushUiEvent,
    requireCli,
    run,
    changeCodexAccount,
  }: Pick<LoginIpcDeps, "codexLogin" | "subscription" | "pushUiEvent"> & {
    requireCli: typeof requireCodingCli;
    run: typeof runCommand;
    changeCodexAccount: <T>(change: () => Promise<T>) => Promise<T>;
  },
): void {
  // A subscription's accounts, each with its email once its CLI told it. Each account's CLI is
  // asked once a run; a list asked for meanwhile waits for that same answer. An email found for one
  // of Studio's own accounts is kept with the account instead, so forgetting the account forgets it.
  const emails = new Map<string, Promise<string | null>>();
  const emailKey = (engine: string, account: string) => `${engine}:${account}`;
  handle("studio:subscription.accounts", async (payload) => {
    const engine = subscription(String(payload?.engine ?? ""));
    if (!engine) throw new Error(MESSAGE.unknownEngine(String(payload?.engine ?? "")));
    const entries = await engine.accounts.list();
    for (const entry of entries) {
      if (entry.email || !entry.signedIn) continue;
      const key = emailKey(payload.engine, entry.id);
      const asked = emails.get(key) ?? engine.accountEmail(entry.home).catch(() => null);
      if (!emails.has(key)) {
        emails.set(key, asked);
        // The Terminal login is the CLI's to change, so its email is kept for this run only.
        void asked.then((email) => keepEmail(engine, entry, key, asked, email)).catch(() => {});
      }
      entry.email = await asked;
    }
    return entries.map(
      ({ id: account, email, terminal, signedIn, active }): SubscriptionAccountView => ({
        id: account,
        email,
        terminal,
        signedIn,
        active,
      }),
    );
  });

  // Switching accounts: every message after this one runs on the chosen account.
  handle("studio:subscription.use-account", async (payload) => {
    const id = String(payload?.engine ?? "");
    const engine = subscription(id);
    if (!engine) throw new Error(MESSAGE.unknownEngine(id));
    const account = String(payload?.account ?? "");
    const use = async () => {
      const status = await engine.runOnAccount(account);
      pushUiEvent({ type: UiEvent.EnginesChanged, payload: {} });
      return status;
    };
    return id === EngineId.Codex ? changeCodexAccount(use) : use();
  });

  // Forget one of the studio's own accounts and run on another. Deletes only studio-owned homes
  // under userData — never the user's own ~/.claude or ~/.codex.
  handle("studio:subscription.forget-studio-login", async (payload) => {
    const engineId = payload?.engine ?? EngineId.ClaudeCode;
    const engine = subscription(engineId);
    if (!engine) return true;
    const account = payload?.account ?? AccountId.Studio;
    if (account === AccountId.Terminal) throw new Error(MESSAGE.terminalSignOut());
    const home = engine.accounts.homeFor(account);
    if (!home) throw new Error(MESSAGE.unknownAccount());
    if (payload?.engine === EngineId.Codex) {
      return changeCodexAccount(async () => {
        await codexLogin.dismiss();
        const installation = await requireCli(EngineId.Codex);
        const binary = installation.path;
        const result = await run(binary, [...CODEX_STUDIO_AUTH_ARGS, "logout"], {
          env: codexSubscriptionEnv({ ...installation.env, CODEX_HOME: home }),
          timeoutMs: CODEX_LOGOUT_TIMEOUT_MS,
        });
        if (result.code !== 0) throw new Error(MESSAGE.disconnectFailed());
        // Studio's first profile keeps its folder and native session history: deleting a directory
        // does not remove keychain credentials. An added account goes whole.
        if (account !== AccountId.Studio) await fs.rm(home, { recursive: true, force: true });
        await forgetAccount(engine, engineId, account);
        return true;
      });
    }
    await fs.rm(home, { recursive: true, force: true });
    await forgetAccount(engine, engineId, account);
    return true;
  });

  /**
   * Keep the email an account's CLI told with that account, unless the account was forgotten while
   * its CLI was asked; the Terminal login's stays in `emails` for this run.
   */
  async function keepEmail(
    engine: SubscriptionEngine,
    entry: { id: string; terminal: boolean },
    key: string,
    asked: Promise<string | null>,
    email: string | null,
  ): Promise<void> {
    const ownAnswer = email !== null && !entry.terminal && emails.get(key) === asked;
    if (!ownAnswer) return;
    await engine.accounts.remember(entry.id, { email });
    emails.delete(key);
  }

  /** The account leaves the list; while it was in use, the first account still signed in runs instead. */
  async function forgetAccount(engine: SubscriptionEngine, engineId: string, account: string): Promise<void> {
    emails.delete(emailKey(engineId, account));
    const wasChosen = (await engine.accounts.chosen()) === account;
    await engine.accounts.forget(account);
    const next = wasChosen ? (await engine.accounts.list()).find((entry) => entry.signedIn) : undefined;
    if (next) await engine.accounts.choose(next.id);
    await engine.recheckLogin();
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: {} });
  }
}

/** The home a sign-in into `account` writes to: an existing account's, or a new one's. */
async function accountSignInHome(engine: SubscriptionEngine, account: string): Promise<string> {
  if (account === NEW_ACCOUNT) return (await engine.accounts.newAccount()).home;
  const home = engine.accounts.homeFor(account);
  if (!home) throw new Error(MESSAGE.unknownAccount());
  return home;
}

/**
 * Where a Codex sign-in writes. Never the Terminal login's own `~/.codex`: Studio prepares the home
 * it signs in to, so a sign-in asked for there, or with no account named, goes to the account in
 * use when it is Studio's own, else to Studio's first.
 */
async function codexSignInHome(engine: SubscriptionEngine, account: string | undefined): Promise<string> {
  if (account && account !== AccountId.Terminal) return accountSignInHome(engine, account);
  const login = await engine.resolveLogin();
  const ownHome = login.source === LoginSource.Isolated && engine.accounts.idFor(login.home) !== null;
  return ownHome && login.home ? login.home : engine.engineHome;
}

/** Where a Claude sign-in writes: the account in use's own home, the environment's, or the system default (null). */
function claudeLoginHome(login: { source: string; home: string | null }): string | null {
  if (login.source === LoginSource.Isolated || login.source === LoginSource.Env) return login.home;
  return null;
}
