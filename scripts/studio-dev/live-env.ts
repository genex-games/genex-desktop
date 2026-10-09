/**
 * What a live studio:dev launch takes from its caller, and where its games may not sit.
 *
 * A live profile meets the app as a Dock launch would: with the machine's own Claude and Codex
 * sign-in. An operator often starts it from inside a coding-agent session, whose environment
 * routes that session's own model calls (an endpoint, a key, Claude Code's and the Agent SDK's
 * switches) and marks every child as nested in it; the app's agents would inherit all of it
 * (`substrate/child-env.ts` keeps same-vendor variables). The routing names and the Claude Code
 * prefixes are shared with the eval lanes (`scripts/evals/lanes/common.ts` builds its list from
 * them); the session markers below are dropped only here.
 * The account homes stay: CLAUDE_CONFIG_DIR and CODEX_HOME are the operator's explicit choice of
 * account, which an eval lane replaces with its own and a live launch keeps.
 */
import fs from "node:fs";
import path from "node:path";

/** Credentials and endpoints a caller's session routes its own model calls through. */
export const SESSION_ROUTING_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
];
/** The homes that pick each coding CLI's account. */
export const ACCOUNT_HOME_ENV_NAMES: readonly string[] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"];
/** Makes Electron run as plain Node instead of the app. */
export const NODE_MODE_ENV_NAMES: readonly string[] = ["ELECTRON_RUN_AS_NODE"];
/** Prefixes of Claude Code's and the Agent SDK's own switches. */
export const AGENT_SESSION_ENV_PREFIXES: readonly string[] = ["CLAUDE_CODE_", "CLAUDE_AGENT_"];
/**
 * What a Claude Code session sets for the commands it runs: that they run inside it, at its effort,
 * with its context, timeout, MCP and OAuth switches and its tracing. A live launch drops them; the
 * eval lanes keep their own list (it is part of `laneFlagsDigest`).
 */
const AGENT_SESSION_MARKERS: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "DISABLE_MICROCOMPACT",
  "API_TIMEOUT_MS",
  "MCP_CONNECTION_NONBLOCKING",
  "MCP_SERVER_CONNECTION_BATCH_SIZE",
  "AI_AGENT",
  "BAGGAGE",
  "USE_STAGING_OAUTH",
  "USE_LOCAL_OAUTH",
];
/** Prefixes of a Claude Code session's further switches that only a live launch drops. */
const LIVE_ONLY_SESSION_PREFIXES: readonly string[] = ["CLAUDE_PREVIEW_"];

/** Every name a live launch drops; the prefixes drop whole families. */
const LIVE_STRIPPED_NAMES: ReadonlySet<string> = new Set([
  ...SESSION_ROUTING_ENV_NAMES,
  ...NODE_MODE_ENV_NAMES,
  ...AGENT_SESSION_MARKERS,
]);

/** Every prefix a live launch drops. */
const LIVE_STRIPPED_PREFIXES: readonly string[] = [...AGENT_SESSION_ENV_PREFIXES, ...LIVE_ONLY_SESSION_PREFIXES];

/** Whether a live launch drops this variable of its caller's. */
const liveStrips = (name: string): boolean =>
  LIVE_STRIPPED_NAMES.has(name) || LIVE_STRIPPED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** The caller's environment for a live launch: everything but its agent session's variables. */
export function liveLaunchEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) if (value !== undefined && !liveStrips(name)) env[name] = value;
  return env;
}

/** The names (never the values) of the caller's variables a live launch drops, sorted. */
export function liveEnvStripped(parent: NodeJS.ProcessEnv): string[] {
  return Object.keys(parent)
    .filter((name) => parent[name] !== undefined && liveStrips(name))
    .sort();
}

/** What `start` and `status` warn an operator about, by code. */
export const StudioDevWarning = {
  GamesRootUnderClaudeFolder: "games-root-under-claude-folder",
} as const;
export type StudioDevWarning = (typeof StudioDevWarning)[keyof typeof StudioDevWarning];

/** One warning: its code and the path it is about. */
export interface StudioDevNotice {
  code: StudioDevWarning;
  at: string;
}

/** The folder Claude Code keeps its settings in; its native Write treats paths below one as sensitive. */
const CLAUDE_FOLDER = ".claude";

/** The `.claude` folder a path sits under, or null. Compared without case, as macOS names files. */
function claudeAncestor(file: string): string | null {
  const parts = path.resolve(file).split(path.sep);
  const at = parts.findIndex((part) => part.toLowerCase() === CLAUDE_FOLDER);
  return at < 0 ? null : parts.slice(0, at + 1).join(path.sep) || path.sep;
}

/** The real path of a file's nearest existing ancestor (itself when it exists), with the rest re-attached. */
function realAncestorPath(file: string, realpath: (p: string) => string): string {
  const missing: string[] = [];
  let at = path.resolve(file);
  for (;;) {
    try {
      return path.join(realpath(at), ...missing);
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return path.resolve(file);
      missing.unshift(path.basename(at));
      at = parent;
    }
  }
}

/**
 * Warnings about a live profile's games root: under a `.claude` folder, as written or once its
 * links are followed, Claude's native Write may refuse or ask for every game file, and an
 * unattended run stalls on permission cards. A warning, not a refusal: worktrees under
 * `.claude/` are the team's normal layout for fixture work. Reads the file system, writes nothing.
 */
export function gamesRootWarnings(
  games: string,
  realpath: (p: string) => string = fs.realpathSync.native,
): StudioDevNotice[] {
  const at = claudeAncestor(games) ?? claudeAncestor(realAncestorPath(games, realpath));
  return at ? [{ code: StudioDevWarning.GamesRootUnderClaudeFolder, at }] : [];
}
