/**
 * What a delegated contractor reads about the studio's own tools: their descriptions and the
 * replies a call gets. Claude Code sees them as MCP tools (`claude-code.ts`), Codex as bridge
 * commands (`codex.ts`); the words are the same so both contractors are told the same thing.
 */

/** The studio tools every delegation may be granted, by the name the contractor calls. */
export const StudioTool = {
  Checkpoint: "checkpoint",
  Capture: "capture",
  /** The Loop chat's question tool: it records the question and ends the reply. */
  AskUser: "ask_user",
  /** The shell of a Claude Code session whose own sandbox cannot start (Windows): Genex's sandbox runs it. */
  RunCommand: "run_command",
} as const;
export type StudioTool = (typeof StudioTool)[keyof typeof StudioTool];

/**
 * Whether a session handed `tools` is an interview: one handed the question card, which reads no
 * message mid-turn (an answer read after its question would reach a turn that had already asked).
 */
export function isInterview(tools: readonly { name: string }[] | undefined): boolean {
  return (tools ?? []).some((tool) => tool.name === StudioTool.AskUser);
}

/** The studio's own MCP server, as a contractor sees it: every tool is `mcp__studio__<name>`. */
export const STUDIO_MCP_SERVER = "studio";
export const STUDIO_TOOL_PREFIX = `mcp__${STUDIO_MCP_SERVER}__`;

/** The name a contractor calls a studio tool by. */
export function studioToolName(name: string): string {
  return `${STUDIO_TOOL_PREFIX}${name}`;
}

/** A bridge call as a command: `node .studio/bridge/tool.mjs <name> …`. */
const STUDIO_BRIDGE_COMMAND = /^node \.studio\/bridge\/tool\.mjs ([\w-]+)/;

/** The studio tool a shell command calls through the bridge, or none for any other command. */
export function bridgedStudioTool(command: string | null | undefined): string | undefined {
  return command ? STUDIO_BRIDGE_COMMAND.exec(command)?.[1] : undefined;
}

/** The studio's shell as the contractor calls it; the host and the never-touch screen read it as `Bash`. */
export const STUDIO_SHELL_TOOL = studioToolName(StudioTool.RunCommand);

/** `run_command`: Claude Code's shell where Genex's sandbox, not Claude Code's own, holds the commands. */
export const RUN_COMMAND_TOOL = {
  description:
    "Run a shell command in this workspace and get its output. This is your shell: Bash is not available here. Commands run under Git Bash inside Genex's sandbox, so use bash syntax and forward slashes. The sandbox writes only your workspace and the folders you were given, has no network, and starts each command fresh in the workspace (no state carries over between calls, and nothing runs in the background: a dev server or watcher would only hold the call until it times out).",
  command: "The command line to run, for example `node --check src/main.js` or `npm test`.",
  timeout: "Milliseconds before the command is stopped (default 2 minutes, at most 10).",
  /** The sandbox could not run the command at all: the session reads why and goes on. */
  failed: (why: string) => `The command could not run: ${why}`,
} as const;

/** `checkpoint`: an optional save point the session may make. */
export const CHECKPOINT_TOOL = {
  description:
    "Save a checkpoint of the game folder with a short note. Genex lights the person's Reload with the note.",
  note: "One short sentence: what changed.",
  reply: "Shown to the user.",
  /** The studio's own checkpoint (`DelegateRequest.onCheckpoint`) threw: the session reads why and goes on. */
  failed: (why: string) => `The checkpoint failed: ${why}`,
} as const;

/** `capture` as Claude Code reads it: an MCP tool whose answer is a list of frame files. */
export const CLAUDE_CAPTURE_TOOL = {
  description:
    "Renders this workspace (your uncommitted edits included) in a hidden preview and saves a screenshot of the page to a file. Returns the file path and the page's console errors.",
  page: "Optional: a .html file in this workspace to capture instead of the game.",
} as const;

/** `capture` as Codex reads it: a bridge command that prints the frame files. */
export const CODEX_CAPTURE_TOOL = {
  description:
    "Renders this workspace (your uncommitted edits included) in a hidden preview and saves a screenshot of the page to a file. Prints the file path and the page's console errors.",
  page: "Optional: a .html file in this workspace to capture instead of the game.",
} as const;

/** What a Loop chat's bridged tool answers: it only records; the harness runs the real thing once the reply ends. */
const INTAKE_REPLY = {
  question:
    "Question recorded. End your reply now; the user's answer arrives in the next turn. Do not launch a run or repeat the question in prose.",
  launch:
    "Recorded — the studio launches this when your reply ends. Do not call this tool again and do not edit any more files; end with a short recap.",
} as const;

/** The answer a delegated contractor gets for calling bridged tool `name` (a launch, or `ask_user`). */
export function intakeToolReply(name: string): string {
  return name === StudioTool.AskUser ? INTAKE_REPLY.question : INTAKE_REPLY.launch;
}
