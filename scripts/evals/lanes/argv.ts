/**
 * Every lane's argv, built in one place so a test can read it (Appendix B). Raw Claude mirrors the
 * product's main agent in its default mode (`--permission-mode auto`, Rule 8); raw Codex mirrors the
 * app's Codex sandbox (`codex.ts` `sandboxArgs`) with the network pinned, host skills disabled per
 * path and the desktop/browser features off (Rule 7). `bypassPermissions` and
 * `--dangerously-bypass-approvals-and-sandbox` can never appear: each builder refuses them. The
 * executables are resolved through the app's CLI discovery, never spelled here.
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CODEX_SCREEN_FEATURES,
  hostSkillFiles,
  hostSkillSuppressionArgs,
} from "../../../src/substrate/engines/codex.ts";
import { cliVersion, requireCodingCli } from "../../../src/substrate/engines/external-cli.ts";
import { StudioFlag } from "../../../src/main/dev/launch-flags.ts";
import type { CodingProvider } from "../../../src/shared/coding-cli.ts";
import { DEFAULT_PERMISSION_MODE, PermissionMode } from "../../../src/shared/permissions.ts";
import { Effort, EvalAgent, NetworkPin } from "../vocabulary.ts";
import type { LaneRegistryRow } from "./types.ts";
import {
  answerText,
  ANSWER_POLICY,
  instructionSuffix,
  RAW_LANE_CREDENTIAL_POLICY,
  rawDeliverable,
  STRIPPED_ENV_NAMES,
  STRIPPED_ENV_PREFIXES,
  textDigest,
} from "./common.ts";

/** Argv a lane may never carry: a permission bypass is over-granting (Rule 8). */
export const BANNED_ARGV: readonly string[] = [
  PermissionMode.Bypass,
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  'sandbox_mode="danger-full-access"',
];

/** Codex features that reach past the workspace: the desktop and the app's own browsers (Rule 7); the app's own list. */
export const DISABLED_CODEX_FEATURES = CODEX_SCREEN_FEATURES;

/** The pinned MCP config raw Claude gets with `--strict-mcp-config`: no servers at all. */
export const EMPTY_MCP_CONFIG = { mcpServers: {} } as const;
/** The pinned MCP config's file name. */
export const PINNED_MCP_FILE = "empty-mcp.json";

/** A builder was asked for a banned argument. */
export class BannedArgvError extends Error {
  readonly argument: string;
  constructor(argument: string) {
    super(`lane argv refused: ${argument}`);
    this.name = "BannedArgvError";
    this.argument = argument;
  }
}

/** `argv` unchanged, or a `BannedArgvError` when any element is a banned argument (alone or as `flag=value`). */
export function assertNoBannedArgv(argv: readonly string[]): readonly string[] {
  for (const argument of argv) {
    const banned = BANNED_ARGV.find((word) => argument === word || argument.startsWith(`${word}=`));
    if (banned) throw new BannedArgvError(banned);
  }
  return argv;
}

/** An effort level as both CLIs spell it, or a `RangeError`. */
function pinnedEffort(effort: string): string {
  if (!(Object.values(Effort) as string[]).includes(effort)) throw new RangeError(`not an effort level: ${effort}`);
  return effort;
}

/**
 * The mode raw Claude runs in: the harness checkout's `DEFAULT_PERMISSION_MODE` (a raw lane has no
 * evaluated build). The runtime and the flags digest both read it from here, so a change moves the pin.
 */
export const RAW_CLAUDE_PERMISSION_MODE: PermissionMode = DEFAULT_PERMISSION_MODE;

/** A TOML basic string: JSON's escaping is a subset TOML accepts. */
const toml = (value: string): string => JSON.stringify(value);

/** What raw Claude's argv is built from. */
export interface RawClaudeArgvInput {
  model: string;
  effort: string;
  /** The pinned empty MCP config. */
  mcpConfigPath: string;
  /** `RAW_CLAUDE_PERMISSION_MODE`: the product's main agent in its default mode. */
  permissionMode: PermissionMode;
  prompt: string;
}

/** Raw Claude (lane B): print mode, stream-json, no settings sources, the pinned empty MCP config. */
export function rawClaudeArgv(input: RawClaudeArgvInput): readonly string[] {
  return assertNoBannedArgv([
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--effort",
    pinnedEffort(input.effort),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfigPath,
    "--permission-mode",
    input.permissionMode,
    input.prompt,
  ]);
}

/** What raw Codex's argv is built from; the prompt goes on stdin. */
export interface RawCodexArgvInput {
  model: string;
  effort: string;
  /** The one writable place: the run's project folder. */
  workspace: string;
  network: boolean;
  /** Absolute `SKILL.md` paths of the operator's host skills, each disabled. */
  disabledSkillPaths: readonly string[];
}

/**
 * The app's Codex confinement (`codex.ts` `sandboxArgs`): workspace-write with exactly one
 * writable root and `approval_policy="never"`, with the network pinned instead of always off.
 */
export function codexSandboxArgs(workspace: string, network: boolean): string[] {
  return [
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    'approval_policy="never"',
    "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify([workspace])}`,
    "-c",
    `sandbox_workspace_write.network_access=${network}`,
  ];
}

/** Raw Codex (lane C): `exec --json` with no user config, the app's sandbox, no login shell, subscription only. */
export function rawCodexArgv(input: RawCodexArgvInput): readonly string[] {
  return assertNoBannedArgv([
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-m",
    input.model,
    "-c",
    `model_reasoning_effort=${toml(pinnedEffort(input.effort))}`,
    ...codexSandboxArgs(input.workspace, input.network),
    "-c",
    "allow_login_shell=false",
    "-c",
    'forced_login_method="chatgpt"',
    ...hostSkillSuppressionArgs(input.disabledSkillPaths),
    ...DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]),
    "-",
  ]);
}

/** What a Genex app launch's argv is built from (lanes A/D). */
export interface GenexAppArgvInput {
  buildDir: string;
  userDataRoot: string;
  specPath: string;
  fixture: boolean;
}

/** The smoke sub-runner launch (§5.3): `--studio-smoke` keeps `--userdata` honoured and the normal profile untouched. */
export function genexAppArgv(input: GenexAppArgvInput): readonly string[] {
  return assertNoBannedArgv([
    input.buildDir,
    StudioFlag.Smoke,
    `${StudioFlag.UserData}=${input.userDataRoot}`,
    `${StudioFlag.EvalLane}=${input.specPath}`,
    ...(input.fixture ? [StudioFlag.EvalFixture] : []),
  ]);
}

/** Whether a raw Codex lane's network pin turns the sandbox network on. */
export function codexNetwork(pin: LaneRegistryRow["network"]): boolean {
  return pin === NetworkPin.On;
}

/** Where Codex reads the operator's host skills from, whatever `CODEX_HOME` says. */
export function defaultHostSkillsDir(home: string = os.homedir()): string {
  return path.join(home, ".agents", "skills");
}

/**
 * Every `<dir>/<name>/SKILL.md` under the host skills folder, sorted, and a linked skill's real
 * path too: the app's own list (`hostSkillFiles`), so lanes C and D disable the same skills. None
 * when the folder is missing.
 */
export async function hostSkillPaths(skillsDir: string = defaultHostSkillsDir()): Promise<string[]> {
  return hostSkillFiles(skillsDir);
}

/** Write the pinned empty MCP config into `dir` and return its path. */
export async function writePinnedMcpConfig(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, PINNED_MCP_FILE);
  await writeFile(file, `${JSON.stringify(EMPTY_MCP_CONFIG)}\n`, "utf8");
  return file;
}

/** A resolved coding CLI: its path and its version number. */
export interface ResolvedCli {
  path: string;
  version: string | null;
}

/** How a lane finds its CLI; injectable, the default is the app's discovery. */
export type CliResolver = (engine: CodingProvider) => Promise<ResolvedCli>;

/** The app's own CLI discovery (`requireCodingCli`), fresh each time; throws when the CLI is not ready. */
export const resolveLaneCli: CliResolver = async (engine) => {
  const cli = await requireCodingCli(engine);
  return { path: cli.path, version: cliVersion(cli.status.version) ?? null };
};

/** Stand-ins for a lane's per-run values, so its digest pins the flags, not the run. */
const PLACEHOLDER = {
  prompt: "<prompt>",
  path: "<path>",
} as const;
/** The deadline the suffix is rendered with for the digest: its text, not a case's minutes, is the pin. */
const DIGEST_DEADLINE_MIN = 1;

/** The argv shape a lane's agent runs with, per-run values replaced by placeholders. */
function argvTemplate(lane: LaneRegistryRow, permissionMode: PermissionMode): readonly string[] {
  switch (lane.agent) {
    case EvalAgent.ClaudeCli:
      return rawClaudeArgv({
        model: lane.model,
        effort: lane.effort,
        mcpConfigPath: PLACEHOLDER.path,
        permissionMode,
        prompt: PLACEHOLDER.prompt,
      });
    case EvalAgent.CodexCli:
      return rawCodexArgv({
        model: lane.model,
        effort: lane.effort,
        workspace: PLACEHOLDER.path,
        network: codexNetwork(lane.network),
        disabledSkillPaths: [PLACEHOLDER.path],
      });
    default:
      return genexAppArgv({
        buildDir: PLACEHOLDER.path,
        userDataRoot: PLACEHOLDER.path,
        specPath: PLACEHOLDER.path,
        fixture: lane.fixture,
      });
  }
}

/**
 * A lane's `flagsDigest`: sha256[:12] of its mode, its argv shape, the instruction texts it
 * receives, the environment policy and the plugins it turns off. Any change to a flag, the suffix,
 * the deliverable, the stripped variables, the raw lanes' credential filter or the plugin list
 * moves it, and with it `harnessPin` (Rule 6).
 */
export function laneFlagsDigest(lane: LaneRegistryRow): string {
  return laneFlagsDigestFor(lane, RAW_CLAUDE_PERMISSION_MODE);
}

/** A lane's `flagsDigest` were raw Claude launched in `permissionMode`; a test passes another mode to see it move. */
export function laneFlagsDigestFor(lane: LaneRegistryRow, permissionMode: PermissionMode): string {
  const raw = lane.agent !== EvalAgent.GenexApp;
  return textDigest(
    lane.agent,
    lane.mode,
    lane.engine,
    argvTemplate(lane, permissionMode).join("\u0001"),
    instructionSuffix(DIGEST_DEADLINE_MIN),
    answerText(ANSWER_POLICY),
    raw ? rawDeliverable(lane.browser) : "",
    STRIPPED_ENV_NAMES.join(","),
    STRIPPED_ENV_PREFIXES.join(","),
    // Only a raw lane carries the marker: a Genex lane's agents get the app's own filter, inside the evaluated build.
    ...(raw ? [RAW_LANE_CREDENTIAL_POLICY] : []),
    // Only a lane that turns plugins off carries them, so every other lane's pin stays where it was.
    ...(lane.disabledPlugins ? [`disabled-plugins:${[...lane.disabledPlugins].sort().join(",")}`] : []),
  );
}
