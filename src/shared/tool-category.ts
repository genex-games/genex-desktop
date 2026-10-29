/**
 * The one `ToolCategory` table every lane's tool calls are counted in (§7 `calls.tools`), in the
 * evals and in the app's field rows alike, and the command classifier behind it. A shell command
 * is unwrapped first (`/bin/zsh -c '…'` → `…`, Rule 17) and then matched at COMMAND POSITION only
 * (the start of the command or of a segment after `&&`, `||`, `;`, `|`), so a word inside a
 * quoted string or a heredoc body is not a call.
 * A file written through the shell (`cat > f <<'EOF'`, `sed -i`, `tee`) is an edit: the demo's
 * local lane wrote every source file that way, and counting only the Edit tool reported it as
 * having changed nothing.
 *
 * These are free-text regexes over commands, so each carries the false-positive note Rule 17
 * requires in `docs/evals.md`; typed tool names are always preferred when the tool has one.
 */
import { ToolCategory } from "./eval-lane.ts";

/** `node .studio/bridge/tool.mjs <tool>` and `mcp__studio__<tool>` both normalize to this prefix. */
const STUDIO_PREFIX = "studio:";
const MCP_PREFIX = "mcp__";
const BRIDGE_TOOL = /(?:^|[\s"'`/])\.studio\/bridge\/tool\.mjs\s+([a-z][a-z0-9_]*)/;

/**
 * One name for the same tool on both engines. Claude calls the studio's tools over MCP; Codex
 * runs the bridge in a shell. Both become `studio:<tool>` so a per-role tool profile compares.
 */
export function normalizeToolName(name: string, argumentText: string): string {
  const mcp = /^mcp__studio__(.+)$/.exec(name);
  if (mcp) return `${STUDIO_PREFIX}${mcp[1]}`;
  const bridge = BRIDGE_TOOL.exec(argumentText || "");
  if (bridge) return `${STUDIO_PREFIX}${bridge[1]}`;
  return name;
}
/** The shared raw-lane browser command (D10); its first run is the raw lanes' first preview. */
export const LOOK_AT_PAGE_COMMAND = "look-at-page";
/** A delegated record's part that is one tool call: the unit the evals and field rows both count. */
export const TOOL_USE_PART = "tool_use";

/** Tool names whose input is a shell command, classified by `classifyCommand`. */
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "command_execution",
  "shell",
  "local_shell_call",
  "exec_command",
]);

/** Every typed tool name the lanes use, by category. A name absent here falls back by prefix, then to `shell`. */
const TOOL_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  Read: ToolCategory.Read,
  NotebookRead: ToolCategory.Read,
  view_image: ToolCategory.Read,
  Grep: ToolCategory.Search,
  Glob: ToolCategory.Search,
  LS: ToolCategory.Search,
  ToolSearch: ToolCategory.Search,
  Edit: ToolCategory.Edit,
  MultiEdit: ToolCategory.Edit,
  Write: ToolCategory.Edit,
  NotebookEdit: ToolCategory.Edit,
  apply_patch: ToolCategory.Edit,
  file_change: ToolCategory.Edit,
  BashOutput: ToolCategory.Shell,
  KillShell: ToolCategory.Shell,
  KillBash: ToolCategory.Shell,
  exec: ToolCategory.Shell,
  write_stdin: ToolCategory.Shell,
  Task: ToolCategory.Subagent,
  Agent: ToolCategory.Subagent,
  spawn_agent: ToolCategory.Subagent,
  WebFetch: ToolCategory.Web,
  WebSearch: ToolCategory.Web,
  web_search: ToolCategory.Web,
  TodoWrite: ToolCategory.Planning,
  ExitPlanMode: ToolCategory.Planning,
  EnterPlanMode: ToolCategory.Planning,
  update_plan: ToolCategory.Planning,
  todo_list: ToolCategory.Planning,
  Skill: ToolCategory.Skill,
};

/** Where a command starts: the beginning, or after a separator or an opening subshell. */
const AT = String.raw`(?:^|[|;&(]\s*|\n\s*)`;
const INSTALL = new RegExp(
  String.raw`${AT}(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|npx\s+playwright\s+install\b|pip3?\s+install\b|brew\s+install\b|apt(?:-get)?\s+install\b)`,
);
const BUILD = new RegExp(
  String.raw`${AT}(?:(?:npm|pnpm|bun)\s+(?:run\s+)?(?:build|test|typecheck|check)\b|yarn\s+(?:run\s+)?(?:build|test|typecheck)\b|npx\s+(?:vite\s+build|tsc|vitest|playwright\s+test)\b|vite\s+build\b|tsc\b|node\s+--test\b|vitest\b|jest\b)`,
);
/** A file written through the shell: `cat`/`tee`/`printf`/`echo` redirected into a file or fed a heredoc, `sed -i`, `tee`. */
const SHELL_WRITE = new RegExp(
  String.raw`${AT}(?:cat|tee|printf|echo)\b[^|;&\n]*(?:>>?\s*(?!\/dev\/null)[^\s&|;]|<<-?\s*['"]?\w+)|${AT}sed\s+-i\b|${AT}tee\s|${AT}apply_patch\b`,
);
const WEB = new RegExp(String.raw`${AT}(?:curl|wget)\b`);
const SEARCH = new RegExp(String.raw`${AT}(?:rg|grep|egrep|find|fd|ls|tree)\b`);
const READ = new RegExp(String.raw`${AT}(?:cat|head|tail|less|more|wc|nl|jq|stat|file|sed\s+-n)\b`);

/** Command-position rules in priority order: the first match names the category. */
const COMMAND_RULES: ReadonlyArray<readonly [RegExp, ToolCategory]> = [
  [INSTALL, ToolCategory.Install],
  [BUILD, ToolCategory.Build],
  [SHELL_WRITE, ToolCategory.Edit],
  [WEB, ToolCategory.Web],
  [SEARCH, ToolCategory.Search],
  [READ, ToolCategory.Read],
];

const SHELL_WRAPPER = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/;
const SINGLE_QUOTE_ESCAPE = /'\\''/g;
const DOUBLE_QUOTE_ESCAPE = /\\(["\\$`])/g;

/**
 * `/bin/zsh -lc "cmd"` → `cmd`. Codex reports every command inside its shell wrapper, so a detector
 * that looks at command position must see through it. An argument that is not exactly one quoted
 * string is returned as written.
 */
export function unwrapShell(command: string): string {
  const match = SHELL_WRAPPER.exec(command.trim());
  const arg = match?.[1]?.trim() ?? "";
  if (arg.length < 2) return command;
  if (arg.startsWith("'") && arg.endsWith("'")) return arg.slice(1, -1).replace(SINGLE_QUOTE_ESCAPE, "'");
  if (arg.startsWith('"') && arg.endsWith('"')) return arg.slice(1, -1).replace(DOUBLE_QUOTE_ESCAPE, "$1");
  return command;
}

/** The first word of a command, without a directory, after unwrapping its shell. */
export function commandHead(command: string): string {
  const first = unwrapShell(command).trimStart().split(/\s+/, 1)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

/** Whether a command runs the shared `look-at-page` browser (the raw lanes' preview signal). */
export function isLookAtPage(command: string): boolean {
  return commandHead(command) === LOOK_AT_PAGE_COMMAND;
}

/** A heredoc's body, up to its terminator line: file content, never a command. */
const HEREDOC_BODY = /(<<-?\s*(['"]?)(\w+)\2)[^\n]*\n[\s\S]*?\n\s*\3[ \t]*(?=\n|$)/g;

/** The command with every heredoc body taken out, so a line of the file it writes is not read as a call. */
export function withoutHeredocBodies(command: string): string {
  return command.replace(HEREDOC_BODY, "$1");
}

/**
 * The category of one shell command, after `unwrapShell` and without heredoc bodies, by the
 * command-position rules above.
 */
export function classifyCommand(command: string): ToolCategory {
  const unwrapped = withoutHeredocBodies(unwrapShell(command));
  if (normalizeToolName("", unwrapped).startsWith(STUDIO_PREFIX)) return ToolCategory.Studio;
  if (isLookAtPage(unwrapped)) return ToolCategory.Browser;
  for (const [pattern, category] of COMMAND_RULES) if (pattern.test(unwrapped)) return category;
  return ToolCategory.Shell;
}

function mcpCategory(name: string): ToolCategory {
  if (normalizeToolName(name, "").startsWith(STUDIO_PREFIX)) return ToolCategory.Studio;
  return name.toLowerCase().includes("browser") || name.includes("playwright")
    ? ToolCategory.Browser
    : ToolCategory.Other;
}

/**
 * The category of one tool call: a shell tool by its command, a typed tool by the table, an MCP
 * tool by its server (`mcp__studio__*` is studio, a browser server is browser). An unknown name,
 * or an unknown MCP server's tool, counts as `other`; a shell command nothing matches stays `shell`.
 */
export function classifyTool(name: string, command: string | null): ToolCategory {
  if (SHELL_TOOLS.has(name)) return classifyCommand(command ?? "");
  const typed = TOOL_CATEGORY[name];
  if (typed) return typed;
  if (name.startsWith(MCP_PREFIX)) return mcpCategory(name);
  if (name.startsWith(STUDIO_PREFIX)) return ToolCategory.Studio;
  return ToolCategory.Other;
}
