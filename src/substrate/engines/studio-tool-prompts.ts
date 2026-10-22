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

/** The studio's own MCP server, as a contractor sees it: every tool is `mcp__studio__<name>`. */
export const STUDIO_MCP_SERVER = "studio";
export const STUDIO_TOOL_PREFIX = `mcp__${STUDIO_MCP_SERVER}__`;

/** The name a contractor calls a studio tool by. */
export function studioToolName(name: string): string {
  return `${STUDIO_TOOL_PREFIX}${name}`;
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

/**
 * The shell a resumed Windows session has this turn: an unattended turn runs its commands in Genex's
 * sandbox and one the person answers in Bash, so a session may remember the other one.
 */
export const SHELL_THIS_TURN = {
  Studio: `This turn your shell is ${STUDIO_SHELL_TOOL} (Genex's sandbox, Git Bash syntax): Bash and PowerShell are off for this turn, whatever this session used before.`,
  Bash: `This turn your shell is Bash (Git Bash): ${STUDIO_SHELL_TOOL} is not here this turn, whatever this session used before.`,
} as const;

/** `checkpoint`: the contractor decides which moments are worth showing. */
export const CHECKPOINT_TOOL = {
  description:
    "Tell the studio the game just reached a moment worth seeing (it first runs end-to-end, a feature became playable). The studio lights the user's Reload with your note, so they see it the moment they press it.",
  note: "One short sentence: what just became visible or playable.",
  reply: "Shown to the user.",
  /** The studio's own checkpoint (`DelegateRequest.onCheckpoint`) threw: the session reads why and goes on. */
  failed: (why: string) => `The checkpoint failed: ${why}`,
} as const;

/** `capture` as Claude Code reads it: an MCP tool whose answer is a list of frame files. */
export const CLAUDE_CAPTURE_TOOL = {
  description:
    "LOOK at your own build: renders THIS workspace (your uncommitted edits included) in a hidden preview and saves fresh screenshots to files. Returns the file paths — Read them to actually see the frames. Use it after every meaningful change; a defect you catch here is an iteration you do not lose.",
  cameras:
    "Comma-separated camera names to capture (as registered in the studio contract). Omit for your part's own cameras, or every registered camera when it has none.",
  page: "A bench page to capture instead of the game: a .html file in this workspace that mounts just your module (for example bench/<part>.html). It loads in seconds; omit it to capture the game, and capture the game before you finish.",
} as const;

/** `capture` as Codex reads it: a bridge command that prints the frame files. */
export const CODEX_CAPTURE_TOOL = {
  description:
    "LOOK at your own build: renders THIS workspace (your uncommitted edits included) in a hidden preview and saves fresh screenshots to files. Prints the file paths — read them to actually see the frames. Use it after every meaningful change.",
  cameras:
    "Comma-separated camera names as registered in the studio contract. Omit for your part's own cameras, or every camera when it has none.",
  page: "A bench page to capture instead of the game: a .html file in this workspace that mounts just your module (for example bench/<part>.html). Omit it to capture the game, and capture the game before you finish.",
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
