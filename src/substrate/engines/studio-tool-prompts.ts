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
} as const;
export type StudioTool = (typeof StudioTool)[keyof typeof StudioTool];

/** The studio's own MCP server, as a contractor sees it: every tool is `mcp__studio__<name>`. */
export const STUDIO_MCP_SERVER = "studio";
export const STUDIO_TOOL_PREFIX = `mcp__${STUDIO_MCP_SERVER}__`;

/** The name a contractor calls a studio tool by. */
export function studioToolName(name: string): string {
  return `${STUDIO_TOOL_PREFIX}${name}`;
}

/** `checkpoint`: the contractor decides which moments are worth showing. */
export const CHECKPOINT_TOOL = {
  description:
    "Tell the studio the game just reached a moment worth seeing (it first runs end-to-end, a feature became playable). The studio lights the user's Reload with your note, so they see it the moment they press it.",
  note: "One short sentence: what just became visible or playable.",
  reply: "Shown to the user.",
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
