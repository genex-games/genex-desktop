/**
 * The two subscription sign-in controllers main owns, wired to the same external installation
 * generation uses. Login state is display-only and transient: it is pushed to the window, never
 * stored with the events.
 */
import os from "node:os";
import { UiEvent } from "../shared/ui-events.ts";
import { findClaudeBinary } from "../substrate/engines/claude-cli.ts";
import { requireCodingCli } from "../substrate/engines/external-cli.ts";
import { openCodeSignInArgs } from "../substrate/engines/opencode-cli.ts";
import { childEnv } from "../substrate/child-env.ts";
import type { ClaudeLoginState } from "../shared/claude-login.ts";
import type { CodexLoginState } from "../shared/codex-login.ts";
import { ClaudeLoginController } from "./claude-login.ts";
import { CodexLoginController } from "./codex-login.ts";
import type { TerminalService } from "./terminal-service.ts";
import { EngineId } from "../shared/providers.ts";
import { TerminalKind } from "../shared/terminal.ts";

/**
 * Both subscriptions answer the same three questions — which login would I use, sign me in,
 * forget the studio's own account — so the IPC speaks to them through this shape rather than
 * naming a vendor. Which engines exist is `SUBSCRIPTION_ENGINES`, next to where they are
 * registered.
 */
export interface SubscriptionEngine {
  engineHome: string;
  resolveLogin(): Promise<{ source: "env" | "isolated" | "system" | "none"; home: string | null }>;
  recheckLogin(): Promise<unknown>;
}

export interface LoginControllerDeps {
  terminals: Pick<TerminalService, "open" | "stop">;
  openExternal(url: string): Promise<unknown>;
  subscription(id: string): SubscriptionEngine | null;
  pushUiEvent(event: UiEvent): void;
  /** Show the Codex sign-in state: the dialog covers the stage, so the native preview hides. */
  showCodexState(state: CodexLoginState): void;
  showClaudeState(state: ClaudeLoginState): void;
  /** OpenCode's sign-in ended: read the models it can run now. */
  onOpenCodeSignedIn?(): Promise<unknown>;
  /** The installed CLI each sign-in runs; the studio's own resolver unless a test gives another. */
  requireCli?: typeof requireCodingCli;
  findBinary?: typeof findClaudeBinary;
}

export function createLoginControllers({
  terminals,
  openExternal,
  subscription,
  pushUiEvent,
  showCodexState,
  showClaudeState,
  requireCli = requireCodingCli,
  findBinary = findClaudeBinary,
  onOpenCodeSignedIn,
}: LoginControllerDeps): {
  codexLogin: CodexLoginController;
  claudeLogin: ClaudeLoginController;
  openCodeLogin: OpenCodeLogin;
} {
  let lastCodexLoginPhase = "idle";
  const codexLogin = new CodexLoginController({
    resolveCli: () => requireCli(EngineId.Codex),
    openExternal,
    onState: (state) => {
      // Transient login data never enters the persisted event store or buffered diagnostics.
      showCodexState(state);
      if (state.phase !== lastCodexLoginPhase && ["failed", "cancelled"].includes(state.phase)) {
        void subscription(EngineId.Codex)
          ?.recheckLogin()
          .then(() => pushUiEvent({ type: UiEvent.EnginesChanged, payload: {} }))
          .catch(() => {});
      }
      lastCodexLoginPhase = state.phase;
    },
    onConnected: async () => {
      await subscription(EngineId.Codex)?.recheckLogin();
      pushUiEvent({ type: UiEvent.EnginesChanged, payload: {} });
    },
  });

  /** Native sign-in uses the same external installation as generation. */
  const claudeLogin = new ClaudeLoginController({
    resolveCli: () => requireCli(EngineId.ClaudeCode),
    findBinary,
    terminal: async (options) => {
      const file = await options.findBinary();
      if (!file) return { started: false, missingCli: true };
      const session = terminals.open({
        file,
        args: ["auth", "login"],
        cwd: options.configDir ?? os.tmpdir(),
        env: options.env,
        title: "Claude Code sign-in",
        kind: TerminalKind.ClaudeLogin,
        onUrl: options.onUrl,
        onExit: options.onExit,
      });
      return { started: true, cancel: () => terminals.stop(session.id) };
    },
    openExternal,
    onState: showClaudeState,
    onConnected: async () => {
      await subscription(EngineId.ClaudeCode)?.recheckLogin();
      pushUiEvent({ type: UiEvent.EnginesChanged, payload: {} });
    },
  });
  const openCodeLogin: OpenCodeLogin = {
    async start() {
      const cli = await requireCli(EngineId.OpenCode).catch(() => null);
      if (!cli) return { started: false, missingCli: true };
      terminals.open({
        file: cli.path,
        args: openCodeSignInArgs(cli.status.version),
        cwd: os.tmpdir(),
        // Its own sign-in: OpenCode's settings, no other vendor's variables and no credential. Its
        // provider list comes from the catalog it already has: a refresh can stall for minutes
        // before the first question, and the engine refreshes the models itself after.
        env: childEnv(cli.env, { base: "contractor", vendor: "opencode", set: { OPENCODE_DISABLE_MODELS_FETCH: "1" } }),
        title: "OpenCode sign-in",
        kind: TerminalKind.OpenCodeLogin,
        onExit: () => {
          void onOpenCodeSignedIn?.()?.catch(() => {});
        },
      });
      return { started: true };
    },
  };
  return { codexLogin, claudeLogin, openCodeLogin };
}

/**
 * OpenCode's sign-in: its own `opencode auth login`, in a terminal in its Settings row, for any
 * of the providers it supports. OpenCode keeps what it is given in its own store; the studio
 * rereads the models OpenCode can run once the terminal closes.
 */
export interface OpenCodeLogin {
  start(): Promise<{ started: boolean; missingCli?: boolean }>;
}
