/**
 * What a terminal session runs: the game's shell, a Claude Code or OpenCode sign-in, or one command a
 * chat reply offered.
 */
export const TerminalKind = {
  Shell: "shell",
  ClaudeLogin: "claude-login",
  OpenCodeLogin: "opencode-login",
  Command: "command",
} as const;
export type TerminalKind = (typeof TerminalKind)[keyof typeof TerminalKind];

/** Sign-ins Settings shows in their own row: revealing the dock would close Settings over them. */
const SETTINGS_TERMINALS: ReadonlySet<TerminalKind> = new Set([TerminalKind.OpenCodeLogin]);

/** Whether the dock lists this session; a Settings sign-in shows in Settings instead. */
export const inDock = (session: { kind: TerminalKind }): boolean => !SETTINGS_TERMINALS.has(session.kind);

/** Whether opening this kind brings up the dock: not a chat command's output, nor a Settings sign-in. */
export const revealsDock = (kind: TerminalKind): boolean =>
  kind !== TerminalKind.Command && !SETTINGS_TERMINALS.has(kind);

/** Ephemeral user terminals. Never part of the game/harness tool contract or event store. */
export interface TerminalSession {
  id: string;
  title: string;
  kind: TerminalKind;
  project?: string;
  phase: "starting" | "running" | "stopping" | "exited";
  exitCode?: number;
  error?: string;
  /** A command session's command line, exactly as the chat offered it. */
  command?: string;
  /** A finished command session's last lines of output: plain text, credentials redacted. */
  output?: string[];
  /** It printed a sign-in page the host can open; the address itself stays in main. */
  signInPage?: boolean;
}

export type TerminalEvent =
  | { type: "accessibility"; enabled: boolean }
  | { type: "session"; session: TerminalSession; reveal?: boolean }
  | { type: "data"; id: string; data: string }
  | { type: "removed"; id: string };

export const TERMINAL_LIMITS = {
  sessions: 4,
  scrollback: 3000,
  input: 16_384,
  inFlight: 65_536,
  queue: 262_144,
  chunk: 16_384,
  /** The longest command line a chat reply can offer to run. */
  command: 1000,
} as const;

/** The fence languages whose one-line block is a command the user can run. */
const SHELL_FENCES: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "shell"]);
/** C0 controls end below this code point; DEL and the C1 controls sit in the range after. */
const C0_END = 0x20;
const DEL = 0x7f;
const C1_END = 0x9f;

/** A newline, carriage return, NUL, escape or any other control character a terminal would act on. */
const hasControlCharacter = (text: string): boolean =>
  [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < C0_END || (code >= DEL && code <= C1_END);
  });

/**
 * A command the terminal runs for a chat reply: one line with no control characters, not a
 * prompt transcript (`$ …`) or a comment, within {@link TERMINAL_LIMITS.command}. Null otherwise.
 */
export function runnableCommand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const command = value.trim();
  if (!command || command.length > TERMINAL_LIMITS.command) return null;
  if (hasControlCharacter(command)) return null;
  if (command.startsWith("$ ") || command.startsWith("#")) return null;
  return command;
}

/** The command a fenced code block offers to run: a runnable command in a shell fence (```bash). */
export function fencedCommand(text: string, lang: string | undefined): string | null {
  if (!lang || !SHELL_FENCES.has(lang.toLowerCase())) return null;
  return runnableCommand(text);
}

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    (cols as number) < 2 ||
    (cols as number) > 500 ||
    (rows as number) < 1 ||
    (rows as number) > 300
  )
    throw new Error("Invalid terminal size");
  return { cols: cols as number, rows: rows as number };
}

/** The open session of a sign-in kind, while it has not exited. */
export const liveSignIn = (sessions: readonly TerminalSession[], kind: TerminalKind): TerminalSession | undefined =>
  sessions.find((session) => session.kind === kind && session.phase !== "exited");
