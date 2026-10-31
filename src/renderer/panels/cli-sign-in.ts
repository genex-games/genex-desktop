/**
 * The CLIs that sign in in their own terminal, OpenCode, Grok Build and Cursor: each one's sign-in
 * terminal and the calls that start its sign-in and, for Cursor, forget it. Settings' rows and first
 * launch's screens both run them.
 */
import { EngineId } from "../../shared/providers.ts";
import { TerminalKind } from "../../shared/terminal.ts";

/** The CLIs that sign in in their own terminal. */
export type CliProvider = typeof EngineId.OpenCode | typeof EngineId.Grok | typeof EngineId.Cursor;

/** One CLI's sign-in terminal, its sign-in call, and its sign-out call when Genex signs it out. */
export interface CliSignIn {
  terminal: TerminalKind;
  signIn: () => Promise<{ started: boolean }>;
  signOut?: () => Promise<unknown>;
}

/** Each CLI's sign-in. */
export const CLI_SIGN_IN: Record<CliProvider, CliSignIn> = {
  [EngineId.OpenCode]: { terminal: TerminalKind.OpenCodeLogin, signIn: () => window.studio.openCodeSignIn() },
  [EngineId.Grok]: { terminal: TerminalKind.GrokLogin, signIn: () => window.studio.grokSignIn() },
  [EngineId.Cursor]: {
    terminal: TerminalKind.CursorLogin,
    signIn: () => window.studio.cursorSignIn(),
    signOut: () => window.studio.cursorSignOut(),
  },
};
