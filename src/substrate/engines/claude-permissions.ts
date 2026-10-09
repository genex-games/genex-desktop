/**
 * Claude Code's permissions, as a delegation hands them to the CLI.
 *
 * Two halves. Every session's deny rules are written here at their real absolute paths (Claude
 * Code reads a rule's `/path` relative to the settings that carry it, and only `//path` from the
 * filesystem root), few enough for any command line: the SDK passes every setting to the CLI
 * as one argument. And a game chat's own session, which a person is answering, is given the
 * mode they chose, the rules they saved, and `canUseTool`: the Allow / Deny question it asks is
 * carried to the host and the person's answer back, as Claude Code would ask in a terminal. A
 * build's lead or the run's coordinator asks the same way (`askLead`), from its chat's Auto, Accept
 * edits or Bypass, or from Manual, and the host answers for the person's mode; the host also screens
 * each of its calls first (`leadScreenHook`), ahead of every allow rule, to ask first while the chat
 * is in a mode its session could not be switched to. The picker switches both kinds of session
 * mid-turn (`liveControl`), and both carry the studio's rules for Auto's classifier
 * (claude-auto-mode.ts). A worker of a chat's lead runs in the chat's mode (`workerAskingOptions`),
 * asks as a lead does (`askWorker`), and never reaches what the never-touch list names, in any mode
 * (`neverTouchHook`, `neverTouchFence`).
 */
import { readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { StudioPlatform } from "../../shared/boot.ts";
import {
  GrantKind,
  isPermissionMode,
  ModeSwitchFailure,
  PermissionDecision,
  type PermissionGrant,
  PermissionMode,
  PLAN_TOOL,
  RuleScope,
  WHOLE_TOOL_RULES,
} from "../../shared/permissions.ts";
import { isInside } from "../paths.ts";
import {
  type NeverTouchHit,
  type NeverTouchList,
  neverTouchReason,
  neverTouchVerdict,
  pathVerdict,
  screenedPaths,
} from "./never-touch.ts";
import { STUDIO_TOOL_PREFIX } from "./studio-tool-prompts.ts";
import type {
  DelegateAsks,
  DelegatePermissions,
  LeadAsks,
  PermissionControl,
  PermissionReply,
  ScreenedCall,
  WithdrawnAnswer,
  WorkerAsks,
  WorkerSeat,
} from "./types.ts";

/** What Claude reads when a question ends without the person's answer, and the Plan card's refusals. */
const MESSAGE = {
  withdrawn: "The permission request was withdrawn.",
  denied:
    "The user denied permission for this action. Don't retry it or work around it; stop and ask the user how to proceed.",
  deniedSaying: (message: string) => `The user denied this and said: ${message}`,
  keepPlanning: "The user wants to keep planning. Ask what to change.",
  keepPlanningSaying: (message: string) => `The user wants to keep planning: ${message}`,
  cannotSwitch: "this Claude Code session cannot change its permission mode",
  /** A lead's or coordinator's own way to ask or to plan, refused without asking the host. */
  askInReply:
    "This session cannot ask the person here or change its permission mode. Do not retry it; say in your reply what you need.",
  /** The host could not screen a lead's call: it is refused, never let through. */
  unscreened:
    "The studio could not check this, so it was not allowed. Do not retry it; say in your reply what you needed.",
  /** The never-touch screen could not read a worker's call: it is refused, never let through. */
  untouchable:
    "Genex could not check what this call reaches, so it was not allowed. Do not retry it or work around it; carry on without it.",
  unfenced: (home: string, names: string[], shown: number) =>
    `[studio] Claude home fence: ${names.length} entries of ${home} stay readable to this session ` +
    `(past the rules' size budget, or not to be told apart from its own project): ` +
    `${names.slice(0, shown).join(", ")}${names.length > shown ? `, and ${names.length - shown} more` : ""}\n`,
} as const;

/** Where a suggestion's rule lands in Claude Code's own terms; these two last for the session only. */
const SESSION_DESTINATIONS: ReadonlySet<string> = new Set(["session", "cliArg"]);
/** Where every kept suggestion is pointed: never `.claude/settings.local.json` in the game folder. */
const SESSION_DESTINATION = "session";
/**
 * Claude Code's own ways to ask and to plan: a build's lead or the run's coordinator answers the
 * person in its reply, and its mode is never its own to change.
 */
const LEAD_REFUSED_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "EnterPlanMode", PLAN_TOOL]);
/**
 * What a lead's or coordinator's session does without the host's screen: reading (in Manual a read
 * outside its folders still asks, and the host answers that as any question; Auto reads without
 * asking, as it does for the chat's own session), and its own bookkeeping (a
 * deferred tool's schema, its todo list). The studio's own tools pass too (`STUDIO_TOOL_PREFIX`).
 * Everything else, a command, an edit, the web or a skill, is screened: once the chat has left the
 * mode the session started in, the host asks first, where an allow rule would let it through.
 */
const LEAD_UNSCREENED_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "ToolSearch",
  "TodoWrite",
]);
/** The hook event a tool call's screen answers, in the SDK's spelling. */
const PRE_TOOL_USE = "PreToolUse";
/** The CLI's Auto gate refusing the mode: its words, which only this adapter reads. */
const AUTO_REFUSED = /cannot set permission mode to auto/i;
/** Claude Code's own name for Manual in the modes it reports. */
const REPORTED_MANUAL = "manual";
/** Inside the active config home: the credentials no tool may read, the settings none may edit. */
const CREDENTIAL_FILE = ".credentials.json";
const SETTINGS_FILES = ["settings.json", "settings.local.json", ".claude.json"];
/**
 * What else in its config home the CLI hands an unattended session's model and shell: the plan
 * Plan mode writes, the shell snapshot and environment each command sources, the todo list.
 * Every other top-level entry there (history, other sessions' logs, caches, plugins) is fenced
 * whole.
 */
const SESSION_HOME_ENTRIES: ReadonlySet<string> = new Set(["plans", "shell-snapshots", "session-env", "todos"]);
/** Where the CLI keeps each working folder's transcripts, saved tool output and memory. */
const PROJECTS_DIR = "projects";
/** Claude Code's longest project folder name before it cuts the name and adds a hash. */
const PROJECT_DIR_NAME_MAX = 200;
/** What Claude Code turns into `-` in a project folder's name: anything but a letter or digit. */
const PROJECT_DIR_UNSAFE = /[^a-zA-Z0-9]/g;
/** The characters Claude Code leaves in a project folder's name (its hash suffix included). */
const PROJECT_NAME_CHARACTER = /^[a-zA-Z0-9-]$/;
/** Those characters as the ranges a rule's character class spells: both cases, `-` added last. */
const PROJECT_NAME_RANGES = [
  ["0", "9"],
  ["A", "Z"],
  ["a", "z"],
] as const;
/**
 * The most one unattended session's rules inside its Claude home may weigh, in characters of
 * the settings JSON. The SDK hands all settings to the CLI as ONE command-line argument
 * (`--settings <json>`): a Windows command line holds 32,767 characters, one through a `.cmd`
 * shim 8,191 (command-launch.ts), and the studio's own home gains a project folder per builder
 * worktree every run. Rules past this are left out, and the session's log says which.
 */
const HOME_FENCE_BUDGET = 4_000;
/** How many left-out folders the log names before it only counts them. */
const UNFENCED_NAMED_MAX = 5;
/** Glob and rule characters a folder name keeps literal, as Claude Code escapes a folder it suggests. */
const GLOB_CHARACTERS = /[[\]()|+^$*]/g;
/**
 * A name no rule can spell literally in Claude Code's matcher (node-ignore in CLI 2.1.281): a `?`
 * stays a wildcard however it is escaped, a trailing `*` does too even escaped, and trailing
 * whitespace is stripped. Such an entry is left out of the fence and named in the session's log.
 */
export function unspellable(name: string): boolean {
  return name.includes("?") || /[*\s]$/.test(name);
}
/** Terminal colour and cursor codes Claude Code leaves in a decision reason. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point: they are removed.
const ANSI_ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** A host callback reports; it never ends the session it reports on. */
export function quietly(call: () => void): void {
  try {
    call();
  } catch {
    // Reporting only.
  }
}

/**
 * A folder as Claude Code writes an absolute rule path, the way the CLI builds one itself: `//`
 * then the path with forward slashes; on Windows the drive letter becomes its lowercase first
 * segment (`C:\Users\me` is `//c/Users/me`). A network share keeps its own two slashes after
 * the rule's (`\\server\share` is `///server/share`), as the CLI writes it too, and that rule
 * holds: the CLI's parser (2.1.281) reads a `//` rule from the root `/`, collapses repeated
 * slashes in its pattern (`/server/share/**`), and matches a UNC target turned forward-slashed
 * (`//server/share/x`) relative to `/` (`server/share/x`).
 */
export function absoluteRulePath(dir: string, platform: NodeJS.Platform = process.platform): string {
  const windows = platform === StudioPlatform.Windows;
  const resolved = windows ? path.win32.resolve(dir) : path.posix.resolve(dir);
  const slashed = windows ? resolved.replaceAll("\\", "/") : resolved;
  const drive = /^([A-Za-z]):\//.exec(slashed);
  if (drive) return `//${drive[1]?.toLowerCase()}/${slashed.slice(drive[0].length)}`;
  return `/${slashed.startsWith("/") ? slashed : `/${slashed}`}`;
}

/** Claude Code's own rule syntax: the content ends at the last `)`, so parentheses are escaped. */
function escapeRuleContent(content: string): string {
  return content.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/**
 * A permission rule for a folder and everything in it (or a file: the trailing `/**` also matches
 * the path itself), at its absolute path. Claude Code resolves a rule's `/path` against the root
 * of the settings that carry it (for the SDK's flag settings, the working directory); only
 * `//path` is the filesystem root. A `[` or `*` in a name stays literal.
 */
export function absoluteRule(tool: string, dir: string, platform: NodeJS.Platform = process.platform): string {
  return `${tool}(${escapeRuleContent(`${literalRulePath(dir, platform)}/**`)})`;
}

/** A folder's absolute rule path with every glob character in it kept literal. */
function literalRulePath(dir: string, platform: NodeJS.Platform): string {
  return absoluteRulePath(dir, platform)
    .replaceAll("\\", "\\\\")
    .replace(GLOB_CHARACTERS, (c) => `\\${c}`);
}

/**
 * A rule for every entry of `dir` whose name matches `glob`, and everything in it. The glob is
 * built here from a project folder's own characters (letters, digits, `-`), one character
 * class, `?` and `*`, which Claude Code's matcher reads as gitignore does, case-blind.
 */
function globRule(tool: string, dir: string, glob: string, platform: NodeJS.Platform): string {
  return `${tool}(${escapeRuleContent(`${literalRulePath(dir, platform)}/${glob}/**`)})`;
}

/** Claude Code's own string hash (Java's `hashCode`), which it adds to a long project folder name. */
function cliStringHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

/**
 * The folder Claude Code keeps a working folder's sessions in, under its config home's
 * `projects/`, named as the CLI names it (2.1.281, and the SDK's bundled 2.1.257): every character
 * but a letter or digit becomes `-`; a name past 200 characters is cut there and given the path's
 * hash in base 36.
 */
export function claudeProjectDirName(cwd: string): string {
  const name = cwd.replace(PROJECT_DIR_UNSAFE, "-");
  if (name.length <= PROJECT_DIR_NAME_MAX) return name;
  return `${name.slice(0, PROJECT_DIR_NAME_MAX)}-${Math.abs(cliStringHash(cwd)).toString(36)}`;
}

/** One of the session's own project folder names, as the CLI names its working folder. */
interface OwnProject {
  name: string;
  /** Every folder whose name starts with `name` is the session's own: a cut name, with any hash. */
  prefix: boolean;
}

/**
 * The session's own folders in `projects/`. The CLI names one from the working folder it
 * started in (NFC, as the shell reports it: links resolved), so both spellings count; a cut
 * name counts with any hash, as the CLI itself looks a long one up by its cut prefix.
 */
async function ownProjects(cwd: string): Promise<OwnProject[]> {
  const spellings = [path.resolve(cwd), await realpath(cwd).catch(() => path.resolve(cwd))];
  const names = [...new Set(spellings.map((dir) => claudeProjectDirName(dir.normalize("NFC"))))];
  return names.map((name) =>
    name.length > PROJECT_DIR_NAME_MAX
      ? { name: `${name.slice(0, PROJECT_DIR_NAME_MAX)}-`, prefix: true }
      : { name, prefix: false },
  );
}

/** Whether a folder name is one of the session's own: exactly, or (`blind`) as the CLI's case-blind matcher sees it. */
function isOwnProject(own: OwnProject[], name: string, blind = false): boolean {
  const spelt = (text: string) => (blind ? text.toLowerCase() : text);
  return own.some((o) => (o.prefix ? spelt(name).startsWith(spelt(o.name)) : spelt(name) === spelt(o.name)));
}

/** How many first characters a folder name shares with the nearest of the session's own names, case-blind. */
function sharedStart(name: string, own: OwnProject[]): number {
  const folded = name.toLowerCase();
  const shared = own.map(({ name: ownName }) => {
    const ownFolded = ownName.toLowerCase();
    let length = 0;
    while (length < folded.length && folded[length] === ownFolded[length]) length++;
    return length;
  });
  return Math.max(0, ...shared);
}

/** `start` as the session's own names spell it (they share it case-blind), else as given. */
function ownSpelling(own: OwnProject[], start: string): string {
  const folded = start.toLowerCase();
  return own.find((o) => o.name.toLowerCase().startsWith(folded))?.name.slice(0, start.length) ?? start;
}

/** The characters the session's own names go on with right after `start`, lower-case. */
function ownNext(own: OwnProject[], start: string): Set<string> {
  const folded = start.toLowerCase();
  return new Set(
    own
      .map((o) => o.name.toLowerCase())
      .filter((name) => name.length > folded.length && name.startsWith(folded))
      .map((name) => name.charAt(folded.length)),
  );
}

/** The runs of kept characters from `from` to `to`, as a character class spells them (`a`, `c-z`). */
function characterRuns(from: string, to: string, keep: (c: string) => boolean): string[] {
  const runs: string[] = [];
  const close = (first: string, last: string) => runs.push(first === last ? first : `${first}-${last}`);
  let first: string | null = null;
  let last = from;
  for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code++) {
    const c = String.fromCharCode(code);
    if (keep(c)) {
      first ??= c;
      last = c;
    } else if (first !== null) {
      close(first, last);
      first = null;
    }
  }
  if (first !== null) close(first, last);
  return runs;
}

/**
 * A class of every project-name character but these (given lower-case), each case spelt out:
 * the CLI's matcher is case-blind, and the macOS sandbox profile it derives from a Read rule
 * is not. No range crosses `/` or any other character outside the name alphabet.
 */
function nameClassBut(excluded: ReadonlySet<string>): string {
  const kept = PROJECT_NAME_RANGES.flatMap(([from, to]) =>
    characterRuns(from, to, (c) => !excluded.has(c.toLowerCase())),
  );
  return `[${kept.join("")}${excluded.has("-") ? "" : "-"}]`;
}

/** How one other project folder is fenced: the glob its rule shares (none: by its own name), and how early it branches. */
interface ProjectFence {
  key: string;
  glob: string | null;
  depth: number;
}

/**
 * How one other project folder is fenced, or `null` for one the CLI's case-blind matcher cannot
 * tell from the session's own. The matcher (node-ignore in CLI 2.1.281) has no "not this
 * name": it reads `[!x]` as the characters `!` and `x`. So the fence branches off the session's
 * own names. A folder that leaves them after its first `n` characters is fenced by
 * `<those n>[every name character but the ones they go on with]*`, one rule for all that leave
 * there; one that goes on past a whole own name by `<that name>?*` (never the name itself, nor
 * anything in it); one that stops short of an own name, or leaves it with a character no
 * project name has, by its name. A `?` stays a wildcard in that matcher however it is escaped.
 */
function projectFence(name: string, own: OwnProject[]): ProjectFence | null {
  if (isOwnProject(own, name, true) || unspellable(name)) return null;
  const depth = sharedStart(name, own);
  const byName = { key: `=${name}`, glob: null, depth: Number.MAX_SAFE_INTEGER };
  if (depth === name.length) return byName;
  // The session's own spelling: the matcher is case-blind, the macOS sandbox is not.
  const start = ownSpelling(own, name.slice(0, depth));
  const next = ownNext(own, start);
  if (next.size === 0) return { key: `+${start.toLowerCase()}`, glob: `${start}?*`, depth };
  if (!PROJECT_NAME_CHARACTER.test(name.charAt(depth))) return byName;
  return { key: `[${start.toLowerCase()}`, glob: `${start}${nameClassBut(next)}*`, depth };
}

/** A candidate rule of the home fence, how early it branches (broadest first), and the entries it fences. */
interface FenceRule {
  rule: string;
  depth: number;
  entries: string[];
}

/** Every other folder in `projects/` as the few rules of `projectFence`, broadest first; the ones none can fence. */
async function projectRules(
  home: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
): Promise<{ rules: FenceRule[]; unmatchable: string[] }> {
  const projects = path.join(home, PROJECTS_DIR);
  const own = cwd ? await ownProjects(cwd) : [];
  const others = (await readdir(projects).catch(() => [] as string[])).filter((name) => !isOwnProject(own, name));
  const byKey = new Map<string, FenceRule>();
  const unmatchable: string[] = [];
  for (const name of others.sort()) {
    const entry = path.join(PROJECTS_DIR, name);
    const fence = projectFence(name, own);
    if (!fence) {
      unmatchable.push(entry);
      continue;
    }
    const known = byKey.get(fence.key);
    if (known) known.entries.push(entry);
    else {
      const rule =
        fence.glob === null
          ? absoluteRule("Read", path.join(projects, name), platform)
          : globRule("Read", projects, fence.glob, platform);
      byKey.set(fence.key, { rule, depth: fence.depth, entries: [entry] });
    }
  }
  const rules = [...byKey.values()].sort((a, b) => a.depth - b.depth || a.rule.length - b.rule.length);
  return { rules, unmatchable };
}

/** The rules that fit `HOME_FENCE_BUDGET` in the settings JSON, in order; the entries the rest would have fenced. */
function withinBudget(candidates: FenceRule[]): { rules: string[]; dropped: string[] } {
  const rules: string[] = [];
  const dropped: string[] = [];
  let spent = 0;
  for (const candidate of candidates) {
    const cost = JSON.stringify(candidate.rule).length + 1;
    if (spent + cost > HOME_FENCE_BUDGET) {
      dropped.push(...candidate.entries);
      continue;
    }
    spent += cost;
    rules.push(candidate.rule);
  }
  return { rules, dropped };
}

/**
 * An unattended session's Read rules inside its own Claude home, where nobody answers a
 * question: every top-level entry but what the CLI hands the session (its plans, shell
 * snapshot and environment, todos; the credentials and settings are fenced by name) and, in
 * `projects/`, every folder but this working folder's, by the few globs of `projectFence` (one
 * not made yet has nothing to fence and stays reachable). Named by walking the home, so an
 * entry made later is fenced from the next session. Never more than `HOME_FENCE_BUDGET`
 * characters: top-level entries and the broadest globs first, and `warn` names what stays
 * readable.
 */
export async function homeFence(input: {
  home: string;
  cwd?: string;
  warn: (message: string) => void;
  platform?: NodeJS.Platform;
}): Promise<string[]> {
  const { home, platform = process.platform } = input;
  const byName = new Set([...SESSION_HOME_ENTRIES, CREDENTIAL_FILE, ...SETTINGS_FILES, PROJECTS_DIR]);
  const listed = (await readdir(home).catch(() => [] as string[])).filter((entry) => !byName.has(entry)).sort();
  const entries = listed.filter((entry) => !unspellable(entry));
  const unspelled = listed.filter(unspellable);
  const topLevel = entries.map((entry) => ({
    rule: absoluteRule("Read", path.join(home, entry), platform),
    depth: -1,
    entries: [entry],
  }));
  const projects = await projectRules(home, input.cwd, platform);
  const kept = withinBudget([...topLevel, ...projects.rules]);
  const readable = [...unspelled, ...projects.unmatchable, ...kept.dropped];
  if (readable.length) quietly(() => input.warn(MESSAGE.unfenced(home, readable, UNFENCED_NAMED_MAX)));
  return kept.rules;
}

/** The protected folders as deny targets: whole folders, the credential files, the settings files. */
export interface ProtectedTargets {
  whole: string[];
  secrets: string[];
  settings: string[];
  /** The session's own Claude home, when a protected folder holds it: `homeFence` fences inside it for an unattended session. */
  home: string | null;
}

/** The entries of `dir` other than `keep`, each fenced whole. */
async function siblings(dir: string, keep: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.map((entry) => path.join(dir, entry)).filter((full) => full !== keep);
}

/** From a protected folder down to the config home inside it: every sibling on the way. */
async function siblingsDownTo(root: string, home: string): Promise<string[]> {
  const fenced: string[] = [];
  let dir = root;
  while (dir !== home) {
    const next = path.join(dir, path.relative(dir, home).split(path.sep)[0] ?? "");
    fenced.push(...(await siblings(dir, next)));
    dir = next;
  }
  return fenced;
}

/**
 * The protected folders as deny targets. The session's Claude Code keeps its own home (the
 * studio's `CLAUDE_CONFIG_DIR`, or the sign-in it borrows, the person's `~/.claude`) inside one of
 * them, and a session must still reach what the CLI keeps there for it: the plan Plan mode writes,
 * the shell snapshot its commands source, the long tool output it saves in the working folder's
 * project and asks the model to Read. A deny rule wins over those exceptions, so that one folder
 * is not fenced whole: its credentials are unreadable, its settings never edited, and everything
 * around it stays whole. What else inside it is fenced depends on who answers the session
 * (`permissionRules`). Named by walking the folders, so an entry made later is fenced from the
 * next session.
 */
export async function protectedTargets(protectedPaths: string[], configHome: string | null): Promise<ProtectedTargets> {
  const home = configHome ? path.resolve(configHome) : null;
  const whole: string[] = [];
  let inside = false;
  for (const root of [...new Set(protectedPaths.map((p) => path.resolve(p)))]) {
    if (!home || !isInside(root, home)) {
      whole.push(root);
      continue;
    }
    inside = true;
    whole.push(...(await siblingsDownTo(root, home)));
  }
  if (!home || !inside) return { whole, secrets: [], settings: [], home: null };
  return {
    whole,
    secrets: [path.join(home, CREDENTIAL_FILE)],
    settings: SETTINGS_FILES.map((file) => path.join(home, file)),
    home,
  };
}

/** What `permissionRules` needs to know about a session. */
export interface RuleInput {
  protectedPaths: string[];
  /** The Claude config home the session's CLI uses. */
  configHome: string | null;
  /** The session's working folder, whose project in the config home stays reachable. */
  cwd?: string;
  denyReads: string[];
  /** A session that asks (the person's, a lead's): its saved allows and host files; absent when unattended. */
  permissions: DelegateAsks | undefined;
  /** Where an unattended session's note of what its Claude home fence left readable goes (its log). */
  warn?: (message: string) => void;
}

/**
 * A person's session: no sandbox under it, so the rules fence Claude Code's own file tools in
 * every mode (a deny rule holds even in Bypass permissions). The studio's secrets are neither
 * read nor edited through them and its own files never edited. Inside the session's Claude home
 * only the credentials and settings are fenced: everything else there (other projects'
 * transcripts, the prompt history) is reached as Claude Code reaches it for a person in a
 * terminal, which is parity, not a gap: a read outside the working folders asks in Manual and
 * Accept edits, Auto leaves it to the classifier, Bypass allows it. A shell command runs with
 * the person's own access the same way. A build's lead or the run's coordinator is fenced the same.
 */
function personDeny(fence: ProtectedTargets, input: RuleInput, permissions: DelegateAsks): string[] {
  const unreadable = [...fence.whole, ...fence.secrets];
  return [
    ...unreadable.flatMap((p) => [absoluteRule("Read", p), absoluteRule("Edit", p)]),
    ...[...fence.settings, ...permissions.protectWrites].map((p) => absoluteRule("Edit", p)),
    ...input.denyReads.map((p) => absoluteRule("Read", p)),
  ];
}

/**
 * An unattended session: Read rules only (its sandboxed shell writes nothing protected, and
 * the sandbox inherits these as `denyRead`), with its Claude home fenced to what the CLI hands
 * it (`homeFence`), because nobody is there to answer a question about the rest.
 */
async function unattendedDeny(fence: ProtectedTargets, input: RuleInput): Promise<string[]> {
  const inside = fence.home
    ? await homeFence({ home: fence.home, cwd: input.cwd, warn: input.warn ?? ((message) => console.warn(message)) })
    : [];
  return [
    ...[...fence.whole, ...fence.secrets].map((p) => absoluteRule("Read", p)),
    ...inside,
    ...input.denyReads.map((p) => absoluteRule("Read", p)),
  ];
}

/** A session's `permissions` settings: the saved allows (a session that asks only) and the deny rules. */
export async function permissionRules(input: RuleInput): Promise<{ allow?: string[]; deny?: string[] }> {
  const fence = await protectedTargets(input.protectedPaths, input.configHome);
  const { permissions } = input;
  const deny = permissions ? personDeny(fence, input, permissions) : await unattendedDeny(fence, input);
  return {
    ...(permissions?.allow.length ? { allow: permissions.allow } : {}),
    ...(deny.length ? { deny } : {}),
  };
}

/** An allow-rule suggestion as grants, minus any whole shell or file tool; the rules kept. */
function ruleGrants(update: Extract<PermissionUpdate, { type: "addRules" }>) {
  const scope = SESSION_DESTINATIONS.has(update.destination) ? RuleScope.Chat : RuleScope.Game;
  // Never a whole shell or file tool: Claude Code hides "always" when the rule would reach
  // further than the question asked, and the SDK drops the flag that says so.
  const rules = (update.rules ?? []).filter((rule) => rule.ruleContent || !WHOLE_TOOL_RULES.has(rule.toolName));
  const grants: PermissionGrant[] = rules.map((rule) => ({
    kind: GrantKind.Rule,
    rule: rule.ruleContent ? `${rule.toolName}(${escapeRuleContent(rule.ruleContent)})` : rule.toolName,
    scope,
  }));
  return { grants, rules };
}

/** One suggestion's grants and, when it widens anything, the suggestion pointed at the session. */
function suggestionGrants(update: PermissionUpdate): { grants: PermissionGrant[]; kept: PermissionUpdate | null } {
  if (update.type === "addRules" && update.behavior === "allow") {
    const { grants, rules } = ruleGrants(update);
    return { grants, kept: rules.length ? { ...update, rules, destination: SESSION_DESTINATION } : null };
  }
  if (update.type === "setMode" && isPermissionMode(update.mode)) {
    return {
      grants: [{ kind: GrantKind.Mode, mode: update.mode }],
      kept: { ...update, destination: SESSION_DESTINATION },
    };
  }
  if (update.type === "addDirectories" && update.directories?.length) {
    const grants: PermissionGrant[] = update.directories.map((directory) => ({
      kind: GrantKind.Directory,
      path: directory,
    }));
    return { grants, kept: { ...update, destination: SESSION_DESTINATION } };
  }
  return { grants: [], kept: null };
}

/**
 * Claude Code's "don't ask again" suggestions, as the studio's grants. Only what widens
 * permission survives: an allow rule (its own destination says whether it was for this chat or
 * for the project), a mode, a folder. The suggestions kept are returned alongside, pointed at
 * the session: the CLI would otherwise write `.claude/settings.local.json` into the game folder,
 * which the next session never loads. The host keeps the grants instead.
 */
export function permissionGrants(suggestions: PermissionUpdate[] = []): {
  grants: PermissionGrant[];
  updates: PermissionUpdate[];
} {
  const grants: PermissionGrant[] = [];
  const updates: PermissionUpdate[] = [];
  for (const update of suggestions) {
    const one = suggestionGrants(update);
    grants.push(...one.grants);
    if (one.kept) updates.push(one.kept);
  }
  return { grants, updates };
}

/** A delegation's session once `query()` has started it. */
export interface RunningSession {
  stream: { setPermissionMode?: (mode: string) => Promise<void> } | null;
}

/** Is this the host's own withdrawal, whose words are not the person's? */
function isWithdrawal(answer: PermissionReply | null): answer is WithdrawnAnswer {
  return answer !== null && "withdrawn" in answer && answer.withdrawn === true;
}

/** How a deny reads to Claude: the host's withdrawal as it is, the person's words, or a plain stop. */
function denied(answer: PermissionReply | null, plan: boolean): PermissionResult {
  if (isWithdrawal(answer)) return { behavior: "deny", message: answer.message };
  const message = answer?.decision === PermissionDecision.Deny ? answer.message?.trim() : "";
  if (message)
    return { behavior: "deny", message: plan ? MESSAGE.keepPlanningSaying(message) : MESSAGE.deniedSaying(message) };
  return { behavior: "deny", message: plan ? MESSAGE.keepPlanning : MESSAGE.denied };
}

/** A plan approved: work continues in the mode the person picked on the card, not the one before Plan. */
function planApproved(mode: string, input: Record<string, unknown>, running: RunningSession): PermissionResult {
  if (mode !== PermissionMode.Auto) {
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: mode as PermissionMode, destination: SESSION_DESTINATION }],
    };
  }
  // Auto goes through Claude Code's own gate, as the picker does: a mode set by an answer would
  // skip it. Leave Plan for Manual, then ask for Auto once the answer is in; where the plan or
  // model has no Auto the CLI refuses, and the session goes on asking first.
  setImmediate(() => void running.stream?.setPermissionMode?.(PermissionMode.Auto)?.catch(() => {}));
  return {
    behavior: "allow",
    updatedInput: input,
    updatedPermissions: [{ type: "setMode", mode: PermissionMode.Manual, destination: SESSION_DESTINATION }],
  };
}

/** The person's answer as the CLI takes it. */
function answerResult(
  answer: PermissionReply | null,
  input: Record<string, unknown>,
  updates: PermissionUpdate[],
  running: RunningSession,
  plan: boolean,
): PermissionResult {
  switch (answer?.decision) {
    case PermissionDecision.Allow:
      return { behavior: "allow", updatedInput: input };
    case PermissionDecision.Always:
      return { behavior: "allow", updatedInput: input, ...(updates.length ? { updatedPermissions: updates } : {}) };
    case PermissionDecision.ApprovePlan:
      return planApproved(answer.mode, input, running);
    default:
      return denied(answer, plan);
  }
}

/** The optional words of Claude Code's question, without the ones it left out. */
function askWords(options: Parameters<CanUseTool>[2]): Record<string, string> {
  const reason = options.decisionReason?.replace(ANSI_ESCAPES, "").trim();
  const words: Record<string, string | undefined> = {
    title: options.title,
    displayName: options.displayName,
    description: options.description,
    reason,
    blockedPath: options.blockedPath,
    agentId: options.agentID,
  };
  return Object.fromEntries(Object.entries(words).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

/**
 * The Allow / Deny question, asked in the chat instead of a terminal. Claude Code decides what
 * to ask and when (mode, rules, its own safety checks) exactly as it would for a person at a
 * prompt; this only carries the question to them and their answer back. Nothing thrown here
 * reaches the session: a question the work outlived is withdrawn, never a crash.
 */
export function askPerson(permissions: DelegatePermissions, running: RunningSession): CanUseTool {
  return (toolName, input, options) =>
    carryQuestion(permissions, running, toolName, input, options, permissionGrants(options.suggestions));
}

/** Carry one question to the host with the grants "always" would keep, and its answer back. */
async function carryQuestion(
  asks: DelegateAsks,
  running: RunningSession,
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
  { grants, updates }: ReturnType<typeof permissionGrants>,
): Promise<PermissionResult> {
  const withdrawn: PermissionResult = { behavior: "deny", message: MESSAGE.withdrawn };
  if (options.signal.aborted) return withdrawn;
  let answer: PermissionReply;
  try {
    answer = await asks.ask(
      { tool: toolName, input, toolUseId: options.toolUseID, ...askWords(options), always: grants },
      options.signal,
    );
  } catch {
    return withdrawn;
  }
  return answerResult(answer ?? null, input, updates, running, toolName === PLAN_TOOL);
}

/** Grants and kept updates without a mode: a lead's or coordinator's mode is never its own to change. */
function withoutModes({ grants, updates }: ReturnType<typeof permissionGrants>): ReturnType<typeof permissionGrants> {
  return {
    grants: grants.filter((grant) => grant.kind !== GrantKind.Mode),
    updates: updates.filter((update) => update.type !== "setMode"),
  };
}

/**
 * A build's lead's or the run's coordinator's question. Claude Code decides what to ask from the
 * mode the session started in (Manual: every edit and command, and a read outside its folders);
 * the host answers it for the chat's mode, whether or not the person is talking to it. Its own ways
 * to ask the person or to plan are refused here, never carried: it answers in its reply.
 */
export function askLead(lead: DelegateAsks, running: RunningSession): CanUseTool {
  return async (toolName, input, options) => {
    if (LEAD_REFUSED_TOOLS.has(toolName)) return { behavior: "deny", message: MESSAGE.askInReply };
    return carryQuestion(lead, running, toolName, input, options, withoutModes(permissionGrants(options.suggestions)));
  };
}

/** The options that make a session ask the person: their mode, the Bypass switch, and the question. */
export function askingOptions(permissions: DelegatePermissions, running: RunningSession): Record<string, unknown> {
  return {
    // A game chat's own session is not unattended: it is Claude Code as the person would run it in
    // a terminal. It starts in the mode they picked, asks them whatever Claude Code would ask, and
    // may be switched to Bypass mid-turn, which the CLI allows only for a session launched with
    // the flag below.
    permissionMode: permissions.mode,
    allowDangerouslySkipPermissions: true,
    canUseTool: askPerson(permissions, running),
  };
}

/**
 * The options of a build's lead or the run's coordinator in a game chat: the mode the host chose
 * for it (`LeadAsks.mode`), its questions routed by the host. Its chat's Auto, Accept edits or
 * Bypass, so Claude Code decides as it does for the chat's own session; Manual for any other mode,
 * so every edit and command reaches `canUseTool` and the host answers for the chat's mode. Launched,
 * as the chat's own session, with the flag the CLI needs to reach Bypass mid-turn: the picker
 * switches it (`liveControl`), and nothing else can (`askLead` keeps no mode). The host screens each
 * call first (`leadScreenHook`), to ask first while the chat is in a mode it could not be switched to.
 */
export function leadAskingOptions(lead: LeadAsks, running: RunningSession): Record<string, unknown> {
  return {
    permissionMode: lead.mode,
    allowDangerouslySkipPermissions: true,
    canUseTool: askLead(lead, running),
  };
}

/** A PreToolUse hook's refusal, which Claude reads as `reason`; it holds in every mode and over every allow rule. */
export function preToolDeny(reason: string): Record<string, unknown> {
  return {
    decision: "block",
    reason,
    hookSpecificOutput: { hookEventName: PRE_TOOL_USE, permissionDecision: "deny", permissionDecisionReason: reason },
  };
}

/** A PreToolUse hook's demand to ask about the call (`canUseTool`, with `reason`), whatever the mode or an allow rule says. */
function preToolAsk(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: { hookEventName: PRE_TOOL_USE, permissionDecision: "ask", permissionDecisionReason: reason },
  };
}

/** Whether a lead's call goes on without the host's screen: a read, its own bookkeeping, the studio's own tools. */
function unscreened(tool: string): boolean {
  return LEAD_UNSCREENED_TOOLS.has(tool) || tool.startsWith(STUDIO_TOOL_PREFIX);
}

/**
 * A lead's or coordinator's screen, as a PreToolUse hook: Claude Code runs hooks before its deny,
 * ask and allow rules, in every mode, so the host's demand to ask first holds where the mode the
 * session runs in (Auto's classifier, Accept edits), a saved "always allow" rule or the game's own
 * `.claude/settings.json` would have let the call through: a session whose chat is in a mode it
 * could not be switched to. Nothing thrown reaches the session: a screen that fails refuses.
 */
export function leadScreenHook(lead: LeadAsks) {
  return async (input: unknown): Promise<Record<string, unknown>> => {
    const hook = input as {
      hook_event_name?: unknown;
      tool_name?: unknown;
      tool_input?: unknown;
      tool_use_id?: unknown;
    };
    if (hook?.hook_event_name !== PRE_TOOL_USE) return {};
    const tool = typeof hook.tool_name === "string" ? hook.tool_name : "";
    if (unscreened(tool)) return {};
    const toolInput = hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input : {};
    const toolUseId = typeof hook.tool_use_id === "string" ? { toolUseId: hook.tool_use_id } : {};
    const verdict = await lead
      .screen({ tool, input: toolInput as Record<string, unknown>, ...toolUseId })
      .catch(() => ({ message: MESSAGE.unscreened }));
    if (!verdict) return {};
    return "askFirst" in verdict ? preToolAsk(verdict.reason) : preToolDeny(verdict.message);
  };
}

/** A switch the CLI refused, as a typed failure the host reads by its code. */
function switchFailure(mode: string, cause: unknown): Error & { code: ModeSwitchFailure } {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code =
    mode === PermissionMode.Auto && AUTO_REFUSED.test(message)
      ? ModeSwitchFailure.AutoUnavailable
      : ModeSwitchFailure.Unreachable;
  return Object.assign(new Error(message), { code });
}

/**
 * The mode picker's hold on a running session that asks (the chat's own, a lead's, the
 * coordinator's): handed to the host once the session starts, and taken back once when it stops
 * taking control requests (`release`).
 */
export function liveControl(asks: DelegateAsks | undefined, stream: unknown): { release(): void } {
  const onControl = asks?.onControl;
  if (!onControl) return { release: () => {} };
  const live = stream as { setPermissionMode?: (mode: string) => Promise<void> };
  const control: PermissionControl = {
    setMode: async (mode) => {
      if (typeof live.setPermissionMode !== "function")
        throw Object.assign(new Error(MESSAGE.cannotSwitch), { code: ModeSwitchFailure.Unreachable });
      await live.setPermissionMode(mode).catch((cause: unknown) => {
        throw switchFailure(mode, cause);
      });
    },
  };
  let held = true;
  quietly(() => onControl(control));
  return {
    release: () => {
      if (!held) return;
      held = false;
      quietly(() => onControl(null));
    },
  };
}

/** The mode a session reports running in (`manual` is Claude Code's name for `default`). */
export function reportedMode(message: Record<string, unknown>): string {
  const mode = String(message.permissionMode ?? "");
  return mode === REPORTED_MANUAL ? PermissionMode.Manual : mode;
}

/** A worker's question: a lead's (`askLead`), the host naming the worker from the seat it built. */
export function askWorker(asks: WorkerAsks, running: RunningSession): CanUseTool {
  return askLead(asks, running);
}

/**
 * Whether a worker's seat keeps it read-only: Plan (readers run, writers wait for the plan's
 * approval), or a reader the lead started in place.
 */
export function workerReadOnly(seat: WorkerSeat, reader: boolean): boolean {
  return reader || seat.mode === PermissionMode.Plan;
}

/**
 * A worker's box: whether sandboxed commands run unasked, whether one may leave the box (asking),
 * whether it writes, and whether it writes the home folder as well as its roots.
 */
export interface WorkerBox {
  autoAllow: boolean;
  unsandboxed: boolean;
  writes: boolean;
  home: boolean;
}

/**
 * Each mode a worker that asks runs in: the session's mode and its box. Bypass's box writes the
 * home folder too, runs every command unasked and never lets one leave it, so the never-touch list
 * holds at the OS boundary in Bypass as in every other mode.
 */
const WORKER_MODES: Record<Exclude<PermissionMode, typeof PermissionMode.Plan>, WorkerBox> = {
  [PermissionMode.Bypass]: { autoAllow: true, unsandboxed: false, writes: true, home: true },
  [PermissionMode.Auto]: { autoAllow: true, unsandboxed: true, writes: true, home: false },
  [PermissionMode.AcceptEdits]: { autoAllow: false, unsandboxed: true, writes: true, home: false },
  [PermissionMode.Manual]: { autoAllow: false, unsandboxed: true, writes: true, home: false },
};
/** A worker that cannot ask, or a read-only one: the unattended box, writing only its roots (if any). */
const UNASKED_BOX = { autoAllow: true, unsandboxed: false, home: false } as const;

/**
 * A worker's box, in every mode: Bypass's writes the home folder and runs every command in it
 * unasked; Auto runs its sandboxed commands unasked, Accept edits and Manual ask about each; those
 * three may run one outside the box once the mode approves it (Auto's classifier, the person
 * otherwise), held then by the never-touch hook alone. A read-only worker, or one whose engine
 * cannot ask, keeps the unattended box: nothing leaves it.
 */
export function workerBox(seat: WorkerSeat, reader: boolean): WorkerBox {
  if (workerReadOnly(seat, reader)) return { ...UNASKED_BOX, writes: false };
  if (!seat.asks || seat.mode === PermissionMode.Plan) return { ...UNASKED_BOX, writes: true };
  return WORKER_MODES[seat.mode];
}

/**
 * A worker's session options, in the chat's mode the host handed it: Bypass, Auto, Accept edits or
 * Manual, each asking the host what Claude Code asks there (`askWorker`), launched with the flag
 * every session that asks has. A read-only worker (Plan, a reader) and one that cannot ask keep the
 * unattended shape: Accept edits with nobody to ask, so what is not allowed is refused, and the
 * box (`workerBox`) holds the rest. Its mode is fixed for the session: no picker reaches it.
 */
export function workerAskingOptions(
  seat: WorkerSeat,
  running: RunningSession,
  reader = false,
): Record<string, unknown> {
  const asks = seat.asks;
  if (!asks || workerReadOnly(seat, reader)) return { permissionMode: PermissionMode.AcceptEdits };
  return { permissionMode: seat.mode, allowDangerouslySkipPermissions: true, canUseTool: askWorker(asks, running) };
}

/**
 * What a session's own Claude home hands it, by real path: the working folder's projects (the long
 * tool output the CLI saves there and asks the model to Read), open; and its plans, shell
 * snapshots, environment and todos, open for reading only: every session of that home sources
 * those, so a worker that wrote them would run commands in the person's other sessions. A worker's
 * never-touch list keeps these open when a sign-in root holds its Claude home (the person's
 * `~/.claude`, Genex's engine homes); the credentials and settings stay on the list, and so does
 * every other project.
 */
export async function sessionHomeOpen(
  configHome: string,
  cwd: string,
): Promise<{ open: string[]; readOpen: string[] }> {
  const home = await realOf(path.resolve(configHome));
  const projects = path.join(home, PROJECTS_DIR);
  const own = await ownProjects(cwd);
  const listed = own.some((project) => project.prefix) ? await readdir(projects).catch(() => [] as string[]) : [];
  const names = own.flatMap((project) =>
    project.prefix ? listed.filter((name) => name.startsWith(project.name)) : [project.name],
  );
  return {
    open: names.map((name) => path.join(projects, name)),
    readOpen: [...SESSION_HOME_ENTRIES].map((entry) => path.join(home, entry)),
  };
}

/** `dir` fenced around the open folders inside it: every entry on the way that holds none, whole. */
async function fenceAround(dir: string, open: string[]): Promise<string[]> {
  const inside = open.filter((folder) => isInside(dir, folder));
  if (!inside.length) return [dir];
  if (inside.some((folder) => path.resolve(folder) === dir)) return [];
  const entries = await readdir(dir).catch(() => [] as string[]);
  const fenced = await Promise.all(entries.map((entry) => fenceAround(path.join(dir, entry), inside)));
  return fenced.flat();
}

/**
 * The never-touch list as the folders a worker's box denies: its reads around the folders open to
 * it and open for reading, its writes around the open ones alone. A root an open folder sits in
 * (Genex's data, which holds the worker's own copy) is fenced around it, entry by entry, the way the
 * Claude home is (`protectedTargets`): the box's denials win over its writable folders. Named by
 * walking the folders, so an entry made later is fenced from the next session; until then the hook
 * holds it.
 */
export async function neverTouchFence(list: NeverTouchList): Promise<{ reads: string[]; writes: string[] }> {
  const open = list.open.map((folder) => path.resolve(folder));
  const readable = [...open, ...(list.readOpen ?? []).map((folder) => path.resolve(folder))];
  const fence = async (around: string[]) => {
    const fenced = await Promise.all(list.roots.map((root) => fenceAround(path.resolve(root.path), around)));
    return [...new Set(fenced.flat())];
  };
  return { reads: await fence(readable), writes: await fence(open) };
}

/** A path with its links resolved, as far as it exists: a link inside the game may lead anywhere. */
async function realOf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await realOf(parent), path.basename(target));
  }
}

/** One hook input as the call it screens; throws on one it cannot read. */
function screenedCall(hook: { tool_name?: unknown; tool_input?: unknown }): ScreenedCall {
  const tool = hook.tool_name;
  const input = hook.tool_input;
  if (typeof tool !== "string" || !tool) throw new TypeError("a tool call without a tool");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${tool} without its input`);
  return { tool, input: input as Record<string, unknown> };
}

/**
 * The never-touch verdict on a call, its paths as named, then as their links lead: the worker
 * hook's screen (`neverTouchHook`), also run on a job's command before it starts. Throws on a call
 * it cannot read; whoever runs it refuses those.
 */
export async function neverTouchScreen(
  call: ScreenedCall,
  list: NeverTouchList,
  cwd: string,
  home: string,
): Promise<NeverTouchHit | null> {
  const named = neverTouchVerdict(call, list, cwd, home);
  if (named) return named;
  for (const screened of screenedPaths(call, cwd, home)) {
    const real = await realOf(screened.path);
    const hit: NeverTouchHit | null = real === screened.path ? null : pathVerdict({ ...screened, path: real }, list);
    if (hit) return hit;
  }
  return null;
}

/**
 * A worker's never-touch screen, as a PreToolUse hook: Claude Code runs hooks before its deny, ask
 * and allow rules, in every mode, Bypass included. It screens every call, reads included (a lead's
 * screen skips those): a file tool by its paths, a command by the paths it names and any keychain
 * call, each path also as its links lead. Anything it cannot read or decide is refused.
 */
export function neverTouchHook(list: NeverTouchList, cwd: string, home: string = os.homedir()) {
  return async (input: unknown): Promise<Record<string, unknown>> => {
    const hook = input as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown } | null;
    if (hook?.hook_event_name !== PRE_TOOL_USE) return {};
    try {
      const hit = await neverTouchScreen(screenedCall(hook), list, cwd, home);
      return hit ? preToolDeny(neverTouchReason(hit)) : {};
    } catch {
      return preToolDeny(MESSAGE.untouchable);
    }
  };
}
