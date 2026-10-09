/**
 * Subscription sign-in: both providers sign in inside the app, each through its own controller,
 * and forgetting the studio's own account never touches the user's own ~/.claude or ~/.codex.
 */
import fs from "node:fs/promises";
import { UiEvent } from "../../shared/ui-events.ts";
import { runCommand } from "../../substrate/engines/claude-cli.ts";
import { CODEX_STUDIO_AUTH_ARGS, codexSubscriptionEnv } from "../../substrate/engines/codex-cli.ts";
import { requireCodingCli } from "../../substrate/engines/external-cli.ts";
import type { ClaudeLoginController } from "../claude-login.ts";
import type { CodexLoginController } from "../codex-login.ts";
import type { OpenCodeLogin, SubscriptionEngine } from "../login-controllers.ts";
import type { IpcHandle } from "./registrar.ts";
import { EngineId } from "../../shared/providers.ts";
import { LoginSource } from "../../shared/engine-descriptor.ts";
import { SECOND_MS } from "../../shared/duration.ts";

/** How long `codex logout` may take before forgetting the studio's sign-in gives up. */
const CODEX_LOGOUT_TIMEOUT_MS = 8 * SECOND_MS;

/** Why a sign-in or connection change from the renderer is refused. */
const MESSAGE = {
  busy: "Finish or stop the active work before changing the ChatGPT connection.",
  changeInProgress: "A ChatGPT connection change is already in progress.",
  unknownEngine: (id: string) => `unknown subscription engine: ${id}`,
  unknownMethod: "Unknown sign-in method",
  codexUnavailable: "Codex is unavailable",
  disconnectFailed: "Codex could not disconnect. Please try again.",
} as const;

export interface LoginIpcDeps {
  claudeLogin: Pick<ClaudeLoginController, "start" | "snapshot" | "submitCode" | "openBrowser" | "cancel">;
  codexLogin: Pick<CodexLoginController, "start" | "snapshot" | "cancel" | "dismiss" | "openBrowser">;
  openCodeLogin: OpenCodeLogin;
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
      throw new Error(MESSAGE.busy);
    }
    if (changingCodexAccount) throw new Error(MESSAGE.changeInProgress);
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
        const state = await codexLogin.start(engine.engineHome);
        return { started: state.phase !== "failed", error: state.error };
      });
    }
    if (payload?.separate) return claudeLogin.start(engine.engineHome);
    return claudeLogin.start(claudeLoginHome(engine.engineHome, await engine.resolveLogin()));
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
      if (!engine) throw new Error(MESSAGE.codexUnavailable);
      return codexLogin.start(engine.engineHome, method);
    });
  });

  // Forget the studio's own account and fall back to the Mac-wide sign-in. Deletes only the
  // studio-owned isolated home under userData — never the user's own ~/.claude or ~/.codex.
  handle("studio:subscription.forget-studio-login", async (payload) => {
    const engine = subscription(payload?.engine ?? EngineId.ClaudeCode);
    if (!engine) return true;
    if (payload?.engine === EngineId.Codex) {
      return changeCodexAccount(async () => {
        await codexLogin.dismiss();
        const installation = await requireCli(EngineId.Codex);
        const binary = installation.path;
        const result = await run(binary, [...CODEX_STUDIO_AUTH_ARGS, "logout"], {
          env: codexSubscriptionEnv({ ...installation.env, CODEX_HOME: engine.engineHome }),
          timeoutMs: CODEX_LOGOUT_TIMEOUT_MS,
        });
        if (result.code !== 0) throw new Error(MESSAGE.disconnectFailed);
        // Keep the selected profile and native session history. Deleting a directory does not
        // remove keychain credentials, and falling back here could connect a different account.
        await engine.recheckLogin();
        pushUiEvent({ type: UiEvent.EnginesChanged, payload: {} });
        return true;
      });
    }
    await fs.rm(engine.engineHome, { recursive: true, force: true });
    await engine.recheckLogin();
    pushUiEvent({ type: UiEvent.EnginesChanged, payload: {} });
    return true;
  });
}

/** Where a Claude sign-in writes: the studio's own home, the environment's, or the system default (null). */
function claudeLoginHome(engineHome: string, login: { source: string; home: string | null }): string | null {
  if (login.source === LoginSource.Isolated) return engineHome;
  if (login.source === LoginSource.Env) return login.home;
  return null;
}
