/**
 * Run one raw CLI lane (B: Claude, C: Codex): a fresh workspace outside any repository, the lane's
 * argv and eval-home environment, a detached process group under the rail, every stdout line kept
 * with its receive time, and the guards of §5.5 read from typed stream fields: the provider's own
 * failure codes, contamination (Claude's init line against the pins; Codex's parent rollout lists
 * only stock skills, S1), the served main-loop model (Rule 16) and the zero-files check.
 */
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodingProvider } from "../../../src/shared/coding-cli.ts";
import type { PermissionMode } from "../../../src/shared/permissions.ts";
import { EngineId } from "../../../src/shared/providers.ts";
import type { QuotaReader } from "../budget.ts";
import { isSameModel } from "../metrics.ts";
import { BrowserPin, EndedHow, EvalAgent, HarnessFailure } from "../vocabulary.ts";
import {
  type CliResolver,
  codexNetwork,
  defaultHostSkillsDir,
  hostSkillPaths,
  rawClaudeArgv,
  rawCodexArgv,
  RAW_CLAUDE_PERMISSION_MODE,
  resolveLaneCli,
  writePinnedMcpConfig,
} from "./argv.ts";
import {
  holdsAnyFile,
  LANE_PID_FILE,
  PROJECT_DIR,
  laneChildEnv,
  rawDeliverable,
  rawPrompt,
  readStreamRecords,
  type RunWorkspace,
  type SupervisedOutcome,
  type SupervisorDeps,
  SYSTEM_SUPERVISOR,
  createRunWorkspace,
  seedStartFolder,
  superviseProcess,
} from "./common.ts";
import type { EvalsLayout } from "./homes.ts";
import { installLookAtPageTool, writeLookAtPageShim } from "./look-at-page-tool.ts";
import type { LaneRunArtifacts, LaneRunRequest, LaneRunResult } from "./types.ts";

/** A contamination assert that failed (§5.5); any one makes the run a `contamination` harness failure. */
export const ContaminationFinding = {
  /** Claude's stream has no `system/init` line to check. */
  InitMissing: "init-missing",
  McpServers: "mcp-servers",
  Plugins: "plugins",
  /** A skill named like one of the operator's own. */
  OperatorSkill: "operator-skill",
  /** A subagent named like one of the operator's own. */
  OperatorAgent: "operator-agent",
  PermissionMode: "permission-mode",
  /** Codex's parent rollout was not found in the eval home. */
  RolloutMissing: "rollout-missing",
  /** Codex listed a skill outside its stock `.system` root. */
  HostSkill: "host-skill",
  /** Codex injected an `AGENTS.md`. */
  AgentsInstructions: "agents-instructions",
} as const;
export type ContaminationFinding = (typeof ContaminationFinding)[keyof typeof ContaminationFinding];

/** Claude Code `stream-json` wire spellings this module reads. */
const ClaudeWire = {
  System: "system",
  Init: "init",
  Assistant: "assistant",
  Result: "result",
  RateLimitEvent: "rate_limit_event",
  AuthFailed: "authentication_failed",
  RateLimit: "rate_limit",
  Rejected: "rejected",
  MaxTurnsSubtype: "error_max_turns",
  MaxTurnsReason: "max_turns",
} as const;

/** Codex `--json` and rollout wire spellings this module reads. */
const CodexWire = {
  ThreadStarted: "thread.started",
  TurnCompleted: "turn.completed",
  Error: "error",
  TurnFailed: "turn.failed",
  SessionMeta: "session_meta",
  TurnContext: "turn_context",
  ResponseItem: "response_item",
  Message: "message",
  Developer: "developer",
  User: "user",
  SkillsOpen: "<skills_instructions>",
  SkillsClose: "</skills_instructions>",
  AgentsHeader: "# AGENTS.md instructions",
  SystemSkillsDir: ".system",
} as const;

/** Codex's typed error codes (`codex_error_info`, S6) and the harness failure each one is. */
const CODEX_ERROR_FAILURE: Record<string, HarnessFailure> = {
  usage_limit_exceeded: HarnessFailure.QuotaExhausted,
  unauthorized: HarnessFailure.AuthExpired,
  too_many_requests: HarnessFailure.RateLimited,
};
/** HTTP statuses a Claude `result` names in `api_error_status`. */
const HTTP = { Unauthorized: 401, TooManyRequests: 429 } as const;

/** The artifact files of a raw run, beside its project folder. */
const ARTIFACT = {
  Stream: "stream.jsonl",
  Stdout: "stdout.log",
  Stderr: "stderr.log",
  Bin: "bin",
  Pinned: "pinned",
} as const;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((v) => (typeof v === "string" ? [v] : [])) : [];

/** The stream's events, parsed; a line that is not a JSON object is dropped. */
export function streamEvents(text: string): Json[] {
  return readStreamRecords(text).flatMap((entry) => {
    try {
      const event = record(JSON.parse(entry.line));
      return event ? [event] : [];
    } catch {
      return [];
    }
  });
}

/** Whether the served model is the requested one (a dated or context-tagged variant counts). */
export function sameModel(served: string, requested: string): boolean {
  return isSameModel(requested, served);
}

// ── Claude ────────────────────────────────────────────────────────────────────────────────

/** The facts Claude's `system/init` line states. */
export interface ClaudeInit {
  model: string | null;
  version: string | null;
  permissionMode: string | null;
  mcpServers: string[];
  skills: string[];
  agents: string[];
  plugins: number;
}

/** The first `system/init` line's facts, or null. */
export function claudeInit(events: readonly Json[]): ClaudeInit | null {
  const init = events.find((e) => e.type === ClaudeWire.System && e.subtype === ClaudeWire.Init);
  if (!init) return null;
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  return {
    model: typeof init.model === "string" ? init.model : null,
    version: typeof init.claude_code_version === "string" ? init.claude_code_version : null,
    permissionMode: typeof init.permissionMode === "string" ? init.permissionMode : null,
    mcpServers: servers.flatMap((server) => strings([record(server)?.name])),
    skills: strings(init.skills),
    agents: strings(init.agents),
    plugins: Array.isArray(init.plugins) ? init.plugins.length : 0,
  };
}

/** The operator's own names a clean Claude lane must not load: their skills and subagents. */
export interface OperatorNames {
  skills: ReadonlySet<string>;
  agents: ReadonlySet<string>;
}

/** Claude's init line against the pins: no MCP server, no plugin, none of the operator's names, the pinned mode. */
export function claudeContamination(
  init: ClaudeInit | null,
  pins: { permissionMode: PermissionMode; operator: OperatorNames },
): ContaminationFinding[] {
  if (!init) return [ContaminationFinding.InitMissing];
  const found: ContaminationFinding[] = [];
  if (init.mcpServers.length) found.push(ContaminationFinding.McpServers);
  if (init.plugins) found.push(ContaminationFinding.Plugins);
  if (init.skills.some((name) => pins.operator.skills.has(name))) found.push(ContaminationFinding.OperatorSkill);
  if (init.agents.some((name) => pins.operator.agents.has(name))) found.push(ContaminationFinding.OperatorAgent);
  if (init.permissionMode !== pins.permissionMode) found.push(ContaminationFinding.PermissionMode);
  return found;
}

/** Claude's typed assistant `error` codes, and the harness failure each one is. */
const ASSISTANT_ERROR_FAILURE = new Map<unknown, HarnessFailure>([
  [ClaudeWire.AuthFailed, HarnessFailure.AuthExpired],
  [ClaudeWire.RateLimit, HarnessFailure.RateLimited],
]);
/** The HTTP statuses a Claude `result` names in `api_error_status`, and the harness failure each one is. */
const RESULT_STATUS_FAILURE = new Map<unknown, HarnessFailure>([
  [HTTP.Unauthorized, HarnessFailure.AuthExpired],
  [HTTP.TooManyRequests, HarnessFailure.RateLimited],
]);

/** One Claude event's own failure code, from typed fields only (never its words). */
function claudeEventFailure(event: Json): HarnessFailure | null {
  switch (event.type) {
    case ClaudeWire.RateLimitEvent:
      return record(event.rate_limit_info)?.status === ClaudeWire.Rejected ? HarnessFailure.QuotaExhausted : null;
    case ClaudeWire.Assistant:
      return ASSISTANT_ERROR_FAILURE.get(event.error) ?? null;
    case ClaudeWire.Result:
      return RESULT_STATUS_FAILURE.get(event.api_error_status) ?? null;
    default:
      return null;
  }
}

/** The provider's first own failure in a Claude stream. */
function claudeProviderFailure(events: readonly Json[]): HarnessFailure | null {
  for (const event of events) {
    const failure = claudeEventFailure(event);
    if (failure) return failure;
  }
  return null;
}

/** How Claude's run ended by its own account: its last `result` line. */
function claudeEnding(events: readonly Json[]): { finished: boolean; maxTurns: boolean } {
  const result = events.findLast((e) => e.type === ClaudeWire.Result);
  if (!result) return { finished: false, maxTurns: false };
  const maxTurns =
    result.subtype === ClaudeWire.MaxTurnsSubtype || result.terminal_reason === ClaudeWire.MaxTurnsReason;
  return { finished: result.is_error === false, maxTurns };
}

// ── Codex ─────────────────────────────────────────────────────────────────────────────────

/** A skill Codex listed in its `<skills_instructions>` block: its name and its absolute file. */
export interface ListedSkill {
  name: string;
  file: string;
}

/** The skills a `<skills_instructions>` block lists, with each short path expanded through its root table. */
export function parseSkillsBlock(text: string): ListedSkill[] {
  const start = text.indexOf(CodexWire.SkillsOpen);
  if (start < 0) return [];
  const end = text.indexOf(CodexWire.SkillsClose, start);
  const lines = text.slice(start, end < 0 ? undefined : end).split("\n");
  const roots = new Map<string, string>();
  for (const line of lines) {
    const root = /^- `(r\d+)` = `(.+)`\s*$/.exec(line);
    if (root?.[1] && root[2]) roots.set(root[1], root[2]);
  }
  return lines.flatMap((line) => {
    const skill = /^- ([^:`]+): .*\(file: ([^)]+)\)\s*$/.exec(line);
    if (!skill?.[1] || !skill[2]) return [];
    const [head, ...rest] = skill[2].split("/");
    const root = head ? roots.get(head) : undefined;
    return [{ name: skill[1].trim(), file: root ? path.join(root, ...rest) : skill[2] }];
  });
}

/** What Codex's parent rollout says about a run. */
export interface CodexRolloutFacts {
  found: boolean;
  model: string | null;
  effort: string | null;
  version: string | null;
  skills: ListedSkill[];
  agentsInstructions: boolean;
}

const NO_ROLLOUT: CodexRolloutFacts = {
  found: false,
  model: null,
  effort: null,
  version: null,
  skills: [],
  agentsInstructions: false,
};

/** The parent session's rollout file for a thread, anywhere under `<codexHome>/sessions`. */
export async function findRollout(codexHome: string, threadId: string): Promise<string | null> {
  const entries = await readdir(path.join(codexHome, "sessions"), { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  const hit = entries.find((entry) => entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`));
  return hit ? path.join(hit.parentPath, hit.name) : null;
}

/** The texts of a rollout message's content parts. */
const messageTexts = (payload: Json): string[] =>
  Array.isArray(payload.content) ? payload.content.flatMap((part) => strings([record(part)?.text])) : [];

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Fold one rollout message into the facts: the developer's skills block, a user's injected AGENTS.md. */
function foldRolloutMessage(facts: CodexRolloutFacts, payload: Json): void {
  const texts = messageTexts(payload);
  if (payload.role === CodexWire.Developer) for (const part of texts) facts.skills.push(...parseSkillsBlock(part));
  const agents = payload.role === CodexWire.User && texts.some((part) => part.startsWith(CodexWire.AgentsHeader));
  if (agents) facts.agentsInstructions = true;
}

/** Fold one rollout line into the facts. */
function foldRolloutLine(facts: CodexRolloutFacts, line: Json): void {
  const payload = record(line.payload) ?? {};
  if (line.type === CodexWire.SessionMeta && facts.version === null) facts.version = text(payload.cli_version);
  if (line.type === CodexWire.TurnContext && facts.model === null) {
    facts.model = text(payload.model);
    facts.effort = text(payload.effort);
  }
  if (line.type === CodexWire.ResponseItem && payload.type === CodexWire.Message) foldRolloutMessage(facts, payload);
}

/** Read a Codex parent rollout's facts: the served model and effort, the CLI version, the listed skills. */
export async function readCodexRollout(codexHome: string, threadId: string | null): Promise<CodexRolloutFacts> {
  const file = threadId ? await findRollout(codexHome, threadId) : null;
  if (!file) return NO_ROLLOUT;
  const facts: CodexRolloutFacts = { ...NO_ROLLOUT, found: true, skills: [] };
  for (const raw of (await readFile(file, "utf8")).split("\n")) {
    try {
      const line = record(JSON.parse(raw));
      if (line) foldRolloutLine(facts, line);
    } catch {
      /* a partial last line */
    }
  }
  return facts;
}

/** Codex's rollout against the pins: found, only stock `.system` skills, no injected `AGENTS.md`. */
export function codexContamination(facts: CodexRolloutFacts, codexHome: string): ContaminationFinding[] {
  if (!facts.found) return [ContaminationFinding.RolloutMissing];
  const stock = path.join(path.resolve(codexHome), "skills", CodexWire.SystemSkillsDir) + path.sep;
  const found: ContaminationFinding[] = [];
  if (facts.skills.some((skill) => !path.resolve(skill.file).startsWith(stock)))
    found.push(ContaminationFinding.HostSkill);
  if (facts.agentsInstructions) found.push(ContaminationFinding.AgentsInstructions);
  return found;
}

/** The thread id Codex's stream announced. */
export function codexThreadId(events: readonly Json[]): string | null {
  const started = events.find((e) => e.type === CodexWire.ThreadStarted);
  return typeof started?.thread_id === "string" ? started.thread_id : null;
}

/** The provider's own failure, from Codex's typed error codes only. */
function codexProviderFailure(events: readonly Json[]): HarnessFailure | null {
  for (const event of events) {
    const failed = event.type === CodexWire.Error || event.type === CodexWire.TurnFailed;
    if (!failed) continue;
    const info = event.codex_error_info ?? record(event.error)?.codex_error_info;
    if (typeof info === "string" && Object.hasOwn(CODEX_ERROR_FAILURE, info)) return CODEX_ERROR_FAILURE[info] ?? null;
  }
  return null;
}

// ── the guards ────────────────────────────────────────────────────────────────────────────

/** What `detectHarnessFailure` reads. */
export interface HarnessEvidence {
  engine: CodingProvider;
  events: readonly Json[];
  spawnFailed: boolean;
  anyFile: boolean;
  findings: readonly ContaminationFinding[];
  servedModel: string | null;
  requestedModel: string;
  /** The CLI version the run reported differs from the one resolved before it started. */
  versionChanged: boolean;
}

/**
 * The first guard that tripped (§5.5), or null. The provider's own failure codes come first, then
 * an empty stream, the CLI changing under the run, contamination, the served model, and a run
 * that wrote no file at all.
 */
export function detectHarnessFailure(evidence: HarnessEvidence): HarnessFailure | null {
  if (evidence.spawnFailed) return HarnessFailure.CliMissing;
  const provider =
    evidence.engine === EngineId.Codex ? codexProviderFailure(evidence.events) : claudeProviderFailure(evidence.events);
  if (provider) return provider;
  if (!evidence.events.length) return HarnessFailure.EmptyStream;
  if (evidence.versionChanged) return HarnessFailure.CliChanged;
  if (evidence.findings.length) return HarnessFailure.Contamination;
  const mismatch = evidence.servedModel !== null && !sameModel(evidence.servedModel, evidence.requestedModel);
  if (mismatch) return HarnessFailure.ServedModelMismatch;
  if (!evidence.anyFile) return HarnessFailure.ZeroFiles;
  return null;
}

/** How a raw run ended: the rail, a provider limit, another guard, the CLI's own ending, or a crash. */
export function rawEndedHow(
  outcome: Pick<SupervisedOutcome, "railFired" | "exitCode">,
  failure: HarnessFailure | null,
  ending: { finished: boolean; maxTurns: boolean },
): EndedHow {
  if (outcome.railFired) return EndedHow.Deadline;
  if (failure === HarnessFailure.RateLimited || failure === HarnessFailure.QuotaExhausted) return EndedHow.RateLimited;
  if (failure) return EndedHow.HarnessFailure;
  if (ending.maxTurns) return EndedHow.MaxTurns;
  if (outcome.exitCode === 0 && ending.finished) return EndedHow.AgentFinished;
  return EndedHow.Crash;
}

// ── the run ───────────────────────────────────────────────────────────────────────────────

/** What a raw lane needs from the machine; every part is injectable. */
export interface RawLaneDeps {
  supervisor: SupervisorDeps;
  resolveCli: CliResolver;
  /** The operator's `~/.agents/skills`, disabled per path for Codex. */
  hostSkillsDir: string;
  /** The operator's own names Claude must not load. */
  operatorNames: () => Promise<OperatorNames>;
  /** The permission mode raw Claude runs in: the product main agent's default. */
  permissionMode: PermissionMode;
  readQuota: QuotaReader | null;
  parentEnv: NodeJS.ProcessEnv;
  home: string;
  /** The Node that runs the `look-at-page` shim. */
  node: string;
  /** The installed `look-at-page` command the shim runs: a copy outside the checkout (`installLookAtPageTool`). */
  lookAtPageScript: () => Promise<string>;
}

/** The folder names under a directory, or none. */
async function namesIn(dir: string, suffix = ""): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith(suffix)).map((name) => name.slice(0, name.length - suffix.length));
}

/** The operator's Claude skills and subagents under `~/.claude` and the eval home. */
export function operatorNamesFrom(claudeDirs: readonly string[]): () => Promise<OperatorNames> {
  return async () => {
    const skills = await Promise.all(claudeDirs.map((dir) => namesIn(path.join(dir, "skills"))));
    const agents = await Promise.all(claudeDirs.map((dir) => namesIn(path.join(dir, "agents"), ".md")));
    return { skills: new Set(skills.flat()), agents: new Set(agents.flat()) };
  };
}

/** The machine's own dependencies for a raw lane. */
export function systemRawLaneDeps(
  layout: Pick<EvalsLayout, "homes" | "builds">,
  readQuota: QuotaReader | null = null,
): RawLaneDeps {
  const claudeHome = layout.homes.claude;
  const home = os.homedir();
  return {
    supervisor: SYSTEM_SUPERVISOR,
    resolveCli: resolveLaneCli,
    hostSkillsDir: defaultHostSkillsDir(home),
    operatorNames: operatorNamesFrom([path.join(home, ".claude"), claudeHome]),
    permissionMode: RAW_CLAUDE_PERMISSION_MODE,
    readQuota,
    parentEnv: process.env,
    home,
    node: process.execPath,
    lookAtPageScript: () => installLookAtPageTool(layout.builds),
  };
}

/** The engine a raw lane's agent runs, or an error for a Genex lane. */
function rawEngine(request: LaneRunRequest): CodingProvider {
  if (request.lane.agent === EvalAgent.ClaudeCli) return EngineId.ClaudeCode;
  if (request.lane.agent === EvalAgent.CodexCli) return EngineId.Codex;
  throw new Error(`lane ${request.lane.id} is not a raw CLI lane`);
}

/** Where a raw run's artifacts go. */
function rawArtifacts(request: LaneRunRequest, workspace: RunWorkspace | null): LaneRunArtifacts {
  const at = (name: string) => path.join(request.workRoot, name);
  return {
    workRoot: request.workRoot,
    laneRoot: request.laneRoot,
    projectDir: workspace?.projectDir ?? path.join(request.laneRoot, PROJECT_DIR),
    streamPath: at(ARTIFACT.Stream),
    stdoutPath: at(ARTIFACT.Stdout),
    stderrPath: at(ARTIFACT.Stderr),
    transcriptHomes: request.homes,
    snapshotDir: at("snapshots"),
    finalSnapshotDir: null,
    eventLogDir: null,
    reportPath: null,
    specPath: null,
  };
}

/** The argv and stdin for one raw run. */
async function rawLaunch(
  request: LaneRunRequest,
  engine: CodingProvider,
  projectDir: string,
  deps: RawLaneDeps,
): Promise<{ args: readonly string[]; stdin: string | null }> {
  const { lane } = request;
  const prompt = rawPrompt(request.evalCase.brief, request.suffix, request.deliverable ?? rawDeliverable(lane.browser));
  if (engine === EngineId.Codex) {
    const args = rawCodexArgv({
      model: lane.model,
      effort: lane.effort,
      workspace: projectDir,
      network: codexNetwork(lane.network),
      disabledSkillPaths: await hostSkillPaths(deps.hostSkillsDir),
    });
    return { args, stdin: prompt };
  }
  const mcpConfigPath = await writePinnedMcpConfig(path.join(request.workRoot, ARTIFACT.Pinned));
  const args = rawClaudeArgv({
    model: lane.model,
    effort: lane.effort,
    mcpConfigPath,
    permissionMode: deps.permissionMode,
    prompt,
  });
  return { args, stdin: null };
}

/** The contamination findings, served model, CLI version and ending one run's evidence shows. */
async function readEvidence(
  engine: CodingProvider,
  events: readonly Json[],
  request: LaneRunRequest,
  deps: RawLaneDeps,
): Promise<{
  findings: ContaminationFinding[];
  servedModel: string | null;
  version: string | null;
  ending: { finished: boolean; maxTurns: boolean };
}> {
  if (engine === EngineId.Codex) {
    const facts = await readCodexRollout(request.homes.codex, codexThreadId(events));
    const finished = events.at(-1)?.type === CodexWire.TurnCompleted;
    const findings = codexContamination(facts, request.homes.codex);
    return { findings, servedModel: facts.model, version: facts.version, ending: { finished, maxTurns: false } };
  }
  const init = claudeInit(events);
  const findings = claudeContamination(init, {
    permissionMode: deps.permissionMode,
    operator: await deps.operatorNames(),
  });
  return { findings, servedModel: init?.model ?? null, version: init?.version ?? null, ending: claudeEnding(events) };
}

/** A result for a run that never started a process. */
function unstarted(
  request: LaneRunRequest,
  at: string,
  endedHow: EndedHow,
  failure: HarnessFailure | null,
): LaneRunResult {
  return {
    runId: request.runId,
    artifacts: rawArtifacts(request, null),
    startedAt: at,
    endedAt: at,
    endedHow,
    harnessFailure: failure,
    noBuild: null,
    exitCode: null,
    signal: null,
    cliVersion: null,
    questionsAsked: 0,
    answersGiven: 0,
    quotaBefore: null,
    quotaAfter: null,
    contaminationClean: false,
  };
}

/**
 * Run a raw lane end to end and report it. A dry run (`live: false`) spawns nothing and creates
 * nothing; a missing CLI is a `cli-missing` harness failure before any workspace is made.
 */
export async function runRawLane(request: LaneRunRequest, deps: RawLaneDeps): Promise<LaneRunResult> {
  const engine = rawEngine(request);
  const now = () => new Date(deps.supervisor.clock.now()).toISOString();
  if (!request.live) return unstarted(request, now(), EndedHow.Cancelled, null);
  const cli = await deps.resolveCli(engine).catch(() => null);
  if (!cli) return unstarted(request, now(), EndedHow.HarnessFailure, HarnessFailure.CliMissing);
  const workspace = await createRunWorkspace(request.workRoot, deps.home, request.laneRoot);
  if (request.startDir !== null) await seedStartFolder(request.startDir, workspace.projectDir);
  const artifacts = rawArtifacts(request, workspace);
  const shim = request.lane.browser === BrowserPin.LookAtPage;
  // The shim's folder sits in the lane root, beside the project: nothing on the agent's PATH names the evals home.
  const binDir = path.join(request.laneRoot, ARTIFACT.Bin);
  const pathPrefix = shim ? [await writeLookAtPageShim(binDir, deps.node, await deps.lookAtPageScript())] : [];
  const launch = await rawLaunch(request, engine, workspace.projectDir, deps);
  const quotaBefore = (await deps.readQuota?.(engine)) ?? null;
  const outcome = await superviseProcess(
    {
      file: cli.path,
      args: launch.args,
      cwd: workspace.projectDir,
      env: laneChildEnv(deps.parentEnv, request.homes, engine, pathPrefix),
      stdin: launch.stdin,
      streamPath: artifacts.streamPath,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      railMs: request.deadlineMs + request.graceMs,
      pidPath: path.join(request.workRoot, LANE_PID_FILE),
    },
    deps.supervisor,
  );
  const quotaAfter = (await deps.readQuota?.(engine)) ?? null;
  const events = streamEvents(await readFile(artifacts.streamPath ?? "", "utf8").catch(() => ""));
  const evidence = await readEvidence(engine, events, request, deps);
  const failure = detectHarnessFailure({
    engine,
    events,
    spawnFailed: outcome.spawnError !== null,
    anyFile: await holdsAnyFile(workspace.projectDir),
    findings: evidence.findings,
    servedModel: evidence.servedModel,
    requestedModel: request.lane.model,
    versionChanged: Boolean(evidence.version && cli.version && evidence.version !== cli.version),
  });
  return {
    runId: request.runId,
    artifacts,
    startedAt: new Date(outcome.startedAtMs).toISOString(),
    endedAt: new Date(outcome.endedAtMs).toISOString(),
    endedHow: rawEndedHow(outcome, failure, evidence.ending),
    harnessFailure: failure,
    noBuild: null,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    cliVersion: evidence.version ?? cli.version,
    questionsAsked: 0,
    answersGiven: 0,
    quotaBefore,
    quotaAfter,
    contaminationClean: evidence.findings.length === 0,
  };
}
