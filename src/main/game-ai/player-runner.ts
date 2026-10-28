/**
 * Running one genex.games job on the person's own plan by spawning the official, unmodified
 * `claude` / `codex` they signed into themselves (§3.7), ported from genex-demo
 * `apps/cli/src/lib/player/runners.ts`.
 *
 * The vendor rule shapes every line: this never reads, stores or forwards a vendor credential. It
 * spawns a CLI that resolves its own sign-in and reads that CLI's stdout. Around it:
 *  - every API key and endpoint variable is blanked (`runnerEnv`): an exported
 *    `ANTHROPIC_API_KEY` would silently turn a plan-funded game into a bill;
 *  - no tools, no MCP servers, no session, and a fresh empty folder removed afterwards; the
 *    game's text (`job.user`) goes on stdin, never argv, which any process can read;
 *  - the spawn goes through `ProcessSandbox` with reading the home folder denied, bar the job's
 *    folder, the CLI's own install and (Claude Code only) its own home (`runnerPolicy`);
 *  - Claude Code loads no settings file and no memory of the person's (`--setting-sources=`): their
 *    `~/.claude/CLAUDE.md`, hooks and plugins never meet a stranger's prompt;
 *  - a CLI is advertised only after `probeRunner` proves, under that policy, that a canary in the
 *    home folder stays unreadable and the CLI still says it is signed in, and (Claude Code) that a
 *    memory file's canary never reaches a job's answer. Codex's shell tool cannot be removed, so
 *    this is what keeps a prompt injection away from `~/.ssh` or its own sign-in.
 *
 * genex.games serves the base args and the model flag per CLI, so wording and model mapping change
 * without a release. A served flag outside {@link CLAUDE_SERVED_FLAGS} / {@link CODEX_SERVED_FLAGS}
 * (tools, MCP, settings, another folder, a looser sandbox) is not honoured: the built-in invocation
 * runs instead. Diagnostics carry codes and timings, never a prompt or an answer.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AiWatcherRunner } from "../../shared/game-ai-watcher.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { isPlainRecord } from "../../shared/game-ai.ts";
import { childEnv } from "../../substrate/child-env.ts";
import { parseAuthStatus } from "../../substrate/engines/claude-cli.ts";
import { parseCodexAuthStatus } from "../../substrate/engines/codex-cli.ts";
import { type RunRequest, type RunResult, type SandboxPolicy, shellQuote } from "../../substrate/spawn.ts";
import {
  FALLBACK_POLICY,
  type PlayerPolicy,
  PlayerProvider,
  PlayerRelease,
  type RunnerBinaryPolicy,
  type RunnerJob,
  RunnerMode,
  RunnerOutputFormat,
} from "./player-api.ts";
import { MEMORY_PROBE_PROMPT, MEMORY_PROBE_SYSTEM, memoryCanary } from "./player-runner-prompts.ts";

/** Roughly how many bytes a token is worth, for the loose output ceiling. */
const BYTES_PER_TOKEN = 4;
/** The smallest output ceiling: a tiny budget still allows a sentence. */
const MIN_OUTPUT_BYTES = 1024;
/** genex.games' own body limit for a result: never submit more. */
const HARD_OUTPUT_BYTES = 2 * 1024 * 1024;
/** What a run may print beyond its answer (the envelope, the CLI's chatter). */
const OUTPUT_SLACK_BYTES = 64 * 1024;
/** A job may not outlive its lease by much; this bounds a wedged CLI when the caller names nothing. */
const DEFAULT_TIMEOUT_MS = 10 * MINUTE_MS;
/** How long the probe's two runs may take each. */
export const PROBE_TIMEOUT_MS = 20 * SECOND_MS;
/** The longest wait a release may name, in seconds. */
const MAX_RETRY_SECONDS = 86_400;
/** How much of a CLI's first bytes is read for its `#!` line. */
const SHEBANG_BYTES = 256;
/** How much of a run's stderr is read for its failure. */
const STDERR_TAIL_CHARS = 4096;

/** The CLI each funding family runs, and back. */
export const RUNNER_FOR_PROVIDER = {
  [PlayerProvider.Claude]: AiWatcherRunner.Claude,
  [PlayerProvider.ChatGpt]: AiWatcherRunner.Codex,
} as const satisfies Record<PlayerProvider, AiWatcherRunner>;
export const PROVIDER_FOR_RUNNER = {
  [AiWatcherRunner.Claude]: PlayerProvider.Claude,
  [AiWatcherRunner.Codex]: PlayerProvider.ChatGpt,
} as const satisfies Record<AiWatcherRunner, PlayerProvider>;

/** The hosts each CLI answers and refreshes its sign-in on: all the network its box gets. */
const RUNNER_DOMAINS = {
  [AiWatcherRunner.Claude]: ["api.anthropic.com", "claude.ai", "platform.claude.com", "console.anthropic.com"],
  [AiWatcherRunner.Codex]: ["chatgpt.com", "auth.openai.com", "api.openai.com"],
} as const satisfies Record<AiWatcherRunner, readonly string[]>;

/**
 * Every tool Claude Code can offer, denied by name: a list rather than `--tools ""`, which is
 * variadic and was measured swallowing the argument after it; for the same reason it goes last.
 * It sits beside `--permission-prompts none`: the flag stops a tool being offered, the setting
 * stops one being approved, so a tool added in a later release is still caught.
 */
export const CLAUDE_DENIED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
  "TodoWrite",
  "SlashCommand",
  "KillShell",
  "BashOutput",
] as const;

/** A served flag: a switch, a flag taking any word, or a flag taking one of a few values. */
type ServedFlag = "switch" | "word" | readonly string[];

/**
 * The flags genex.games may serve for Claude Code. Each changes how text is produced, never what
 * the CLI may do: tools, MCP, settings (which carry hooks), folders, sessions and the system prompt
 * stay the built-in invocation's.
 */
export const CLAUDE_SERVED_FLAGS: Readonly<Record<string, ServedFlag>> = {
  "-p": "switch",
  "--print": "switch",
  "--output-format": ["text", "json", "stream-json"],
  "--model": "word",
  "--fallback-model": "word",
  "--effort": "word",
  "--max-turns": "word",
  "--no-session-persistence": "switch",
  "--permission-prompts": ["none"],
  "--strict-mcp-config": "switch",
  "--verbose": "switch",
};

/** The flags genex.games may serve for Codex: never a looser sandbox, a config, a profile or a folder. */
export const CODEX_SERVED_FLAGS: Readonly<Record<string, ServedFlag>> = {
  "--model": "word",
  "-m": "word",
  "--ephemeral": "switch",
  "--ignore-user-config": "switch",
  "--skip-git-repo-check": "switch",
  "--sandbox": ["read-only"],
  "-s": ["read-only"],
  "--color": ["never", "auto", "always"],
  "--json": "switch",
};

/** A served flag's value: a word that can never read as a flag. */
const WORD_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/;

/** One CLI found on this Mac: what to spawn and what of its install the box must read. */
export interface RunnerInstall {
  runner: AiWatcherRunner;
  /** The CLI as found (often a link into its install). */
  binary: string;
  /** Folders of its install and interpreter the box reads. */
  readRoots: string[];
  /** Its own sign-in and state home; opened to Claude Code only, never to Codex. */
  homes: string[];
}

/** What a job came to. */
export interface RunnerOutcome {
  ok: boolean;
  /** Present only when ok: the text, or the parsed JSON value. */
  output?: unknown;
  /** The release reason, in genex.games' words. */
  release?: PlayerRelease;
  retryAfterSeconds?: number;
  /** A short code-shaped reason: never the model's words, never the prompt. */
  detail?: string;
  durationMs: number;
}

/** A sandbox one job or one probe runs in, and gives back. */
export interface RunnerSandbox {
  run(request: RunRequest): Promise<RunResult>;
  dispose(): Promise<void>;
}

/** Makes the box for one job: writable `cwd`, and the CLI's own home exempt from the credential denies. */
export type RunnerSandboxFactory = (box: { cwd: string; ownHome: readonly string[] }) => Promise<RunnerSandbox>;

/** What one job runs with. */
export interface RunJobOptions {
  policy: PlayerPolicy;
  install: RunnerInstall;
  sandbox: RunnerSandboxFactory;
  /** Where the job's own folder is made. */
  tmpRoot: string;
  /** The person's home folder, which the box may not read. */
  home: string;
  /** The studio's environment, which `runnerEnv` filters. */
  parentEnv: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  /** Aborted when the watcher stops mid-call. */
  signal?: AbortSignal;
  /** Ids, codes and timings only. */
  log: (line: string) => void;
}

// ── argv ─────────────────────────────────────────────────────────────────────────────────────

/** The flag an arg names (`--x=1` names `--x`), or null for a value. */
const flagOf = (arg: string): string | null => (arg.startsWith("-") ? (arg.split("=")[0] ?? arg) : null);

/** Whether `args` names any of `flags`. */
const names = (args: readonly string[], ...flags: string[]): boolean =>
  args.some((arg) => {
    const flag = flagOf(arg);
    return flag !== null && flags.includes(flag);
  });

/** Whether a value is one a served flag may take. */
function takes(kind: ServedFlag, value: string | undefined): boolean {
  if (kind === "switch") return value === undefined;
  if (value === undefined) return false;
  return kind === "word" ? WORD_RE.test(value) : kind.includes(value);
}

/** How many args the served flag at `index` spans with its value, or null when `allowed` does not take it. */
function servedStep(
  args: readonly string[],
  index: number,
  allowed: Readonly<Record<string, ServedFlag>>,
): number | null {
  const arg = args[index] ?? "";
  const flag = flagOf(arg);
  if (flag === null || !Object.hasOwn(allowed, flag)) return null;
  const kind = allowed[flag] as ServedFlag;
  const inline = arg.includes("=") ? arg.slice(flag.length + 1) : undefined;
  if (inline !== undefined) return takes(kind, inline) ? 1 : null;
  if (kind === "switch") return 1;
  return takes(kind, args[index + 1]) ? 2 : null;
}

/**
 * Whether every arg of a served invocation is a flag `allowed` takes (with its value), after an
 * optional leading subcommand. A positional word anywhere else is refused: it could be a prompt.
 */
function servedArgsAllowed(
  args: readonly string[],
  allowed: Readonly<Record<string, ServedFlag>>,
  subcommand?: string,
): boolean {
  let index = subcommand && args[0] === subcommand ? 1 : 0;
  while (index < args.length) {
    const step = servedStep(args, index, allowed);
    if (step === null) return false;
    index += step;
  }
  return true;
}

/** The served invocation for one CLI when every part of it is allowed, else the built-in one. */
function servedOrBuiltIn(
  served: RunnerBinaryPolicy,
  builtIn: RunnerBinaryPolicy,
  allowed: Readonly<Record<string, ServedFlag>>,
  subcommand?: string,
): RunnerBinaryPolicy {
  const args = served.args ?? builtIn.args ?? [];
  const modelFlag = served.modelFlag;
  const flagAllowed = modelFlag === undefined || allowed[modelFlag] === "word";
  return flagAllowed && servedArgsAllowed(args, allowed, subcommand) ? served : builtIn;
}

/**
 * Claude Code's argv for one job; the prompt is not in it (it goes on stdin). Pure, so a test can
 * change the served policy and read the difference.
 */
export function claudeArgv(job: RunnerJob, served: RunnerBinaryPolicy = {}): string[] {
  const policy = servedOrBuiltIn(served, FALLBACK_POLICY.claude ?? {}, CLAUDE_SERVED_FLAGS);
  const base = [...(policy.args ?? ["-p"])];
  const argv = [...base];
  const add = (flag: string, value?: string): void => {
    if (names(base, flag)) return;
    argv.push(flag, ...(value === undefined ? [] : [value]));
  };
  if (!names(base, "-p", "--print")) argv.unshift("-p");
  if (policy.modelFlag && !names(base, policy.modelFlag)) argv.push(policy.modelFlag, job.model.cliModel);
  // An envelope rather than bare text: `is_error` and `subtype` tell a failure from an answer.
  add("--output-format", "json");
  const structured = job.outputFormat === RunnerOutputFormat.Json && job.schema !== undefined;
  // Two turns for a schema job: producing the structured value is its own turn (measured: one
  // turn ends `error_max_turns` every time). With no tools the second turn can only be that.
  add("--max-turns", structured ? "2" : "1");
  add("--no-session-persistence");
  add("--permission-prompts", "none");
  // The person's own MCP servers are not part of a game's job: an allowlisted one never prompts.
  add("--strict-mcp-config");
  // No settings file (hooks, plugins) and no CLAUDE.md of the person's: a stranger's prompt meets none
  // of them. Never served: a served policy naming setting sources runs the built-in invocation.
  argv.push("--setting-sources=");
  argv.push("--append-system-prompt", job.system);
  if (structured) argv.push("--json-schema", JSON.stringify(job.schema));
  // Variadic, therefore last.
  argv.push("--disallowedTools", ...CLAUDE_DENIED_TOOLS);
  return argv;
}

/** The files a Codex job writes and reads in its own folder. */
export interface CodexFiles {
  cwd: string;
  outFile: string;
  schemaFile?: string;
}

/**
 * Codex's argv for one job: `exec` reads the prompt from stdin when the last argument is `-`,
 * writes the final message to `-o <file>` and takes a schema as a file. `--ephemeral` leaves no
 * session behind and `--ignore-user-config` keeps the person's own config out of a game's job.
 */
export function codexArgv(job: RunnerJob, served: RunnerBinaryPolicy = {}, files: CodexFiles): string[] {
  const policy = servedOrBuiltIn(served, FALLBACK_POLICY.codex ?? {}, CODEX_SERVED_FLAGS, "exec");
  const base = [...(policy.args ?? ["exec"])];
  const argv = base[0] === "exec" ? [...base] : ["exec", ...base];
  const add = (flag: string, ...value: string[]): void => {
    if (!names(base, flag)) argv.push(flag, ...value);
  };
  add("--ephemeral");
  add("--ignore-user-config");
  add("--skip-git-repo-check");
  if (!names(base, "--sandbox", "-s")) argv.push("--sandbox", "read-only");
  argv.push("-C", files.cwd);
  if (files.schemaFile) argv.push("--output-schema", files.schemaFile);
  argv.push("-o", files.outFile);
  add("--color", "never");
  if (policy.modelFlag && !names(base, policy.modelFlag, "-m", "--model"))
    argv.push(policy.modelFlag, job.model.cliModel);
  argv.push("-");
  return argv;
}

// ── what a failure means ─────────────────────────────────────────────────────────────────────

/**
 * What a failure means, in the four words the release route takes. Neither CLI has a stable
 * machine code for "your plan says wait", and that one matters most (the person's budget waits
 * instead of a request failing), so this reads the CLI's own words: it is the one place the
 * watcher does, and it only ever picks a release reason.
 */
export function classifyFailure(text: string): { release: PlayerRelease; retryAfterSeconds?: number } {
  const t = text.toLowerCase();
  if (/rate[ -]?limit|usage limit|quota|too many requests|429|\bresets?\b|limit reached/.test(t)) {
    const retry = parseRetrySeconds(t);
    return retry === undefined
      ? { release: PlayerRelease.RateLimited }
      : { release: PlayerRelease.RateLimited, retryAfterSeconds: retry };
  }
  if (
    /not logged in|please log ?in|\blogin\b|log in to|unauthorized|401|invalid api key|authentication (?:failed|required)|credentials/.test(
      t,
    )
  )
    return { release: PlayerRelease.AuthExpired };
  if (/enoent|command not found|no such file or directory|is not recognized/.test(t))
    return { release: PlayerRelease.RunnerUnavailable };
  return { release: PlayerRelease.Failed };
}

/** Seconds per unit a CLI names its wait in. */
const UNIT_SECONDS = { s: 1, m: 60, h: 3600 } as const;

/** The wait a CLI named (`try again in 5 minutes`, `retry-after: 30`, `resets in 2 hours`), in seconds. */
export function parseRetrySeconds(text: string): number | undefined {
  const header = /retry[ -]after:?\s*(\d+)/.exec(text);
  if (header?.[1]) return clampSeconds(Number(header[1]));
  const phrase =
    /(?:try again|retry|resets?|wait|available again)\D{0,20}?(\d+)\s*(second|sec|minute|min|hour|hr)s?/.exec(text);
  if (!phrase?.[1] || !phrase[2]) return undefined;
  const unit = phrase[2][0] as keyof typeof UNIT_SECONDS;
  return clampSeconds(Number(phrase[1]) * UNIT_SECONDS[unit]);
}

function clampSeconds(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.round(value)));
}

// ── what is read back ────────────────────────────────────────────────────────────────────────

/** The loose ceiling on what is submitted: about `maxOutputTokens`, never past genex.games' limit. */
export function outputByteCeiling(maxOutputTokens: number): number {
  const fromTokens = Math.max(MIN_OUTPUT_BYTES, Math.round(maxOutputTokens * BYTES_PER_TOKEN));
  return Math.min(HARD_OUTPUT_BYTES, fromTokens);
}

/** Claude Code's `--output-format json` envelope as read: an answer, or a failure's code. */
export interface ClaudeEnvelope {
  ok: boolean;
  /** The structured value, on a schema job. */
  result?: unknown;
  text?: string;
  detail?: string;
}

/**
 * Claude Code's envelope, read defensively: an `is_error` run still prints one, a run that died
 * first prints none, and anything before it on stdout is the CLI's own chatter.
 */
export function parseClaudeEnvelope(stdout: string): ClaudeEnvelope {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, detail: "no_output" };
  const start = trimmed.lastIndexOf("\n{");
  const candidate = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  let body: unknown;
  try {
    body = JSON.parse(candidate);
  } catch {
    return { ok: false, detail: "unparseable_envelope", text: trimmed };
  }
  if (!isPlainRecord(body)) return { ok: false, detail: "unparseable_envelope" };
  const text = typeof body.result === "string" ? body.result : undefined;
  const subtype = typeof body.subtype === "string" ? body.subtype : undefined;
  if (body.is_error === true || (subtype !== undefined && subtype !== "success"))
    return { ok: false, detail: subtype ?? "is_error", ...(text === undefined ? {} : { text }) };
  // The parsed value when a schema was given: re-parsing the text would be a second chance to disagree.
  const structured = body.structured_output;
  return {
    ok: true,
    ...(structured === undefined || structured === null ? {} : { result: structured }),
    ...(text === undefined ? {} : { text }),
  };
}

/** Bound and shape what the model produced; trusts none of it. */
export function readOutput(
  value: { result?: unknown; text?: string },
  job: RunnerJob,
): { ok: true; output: unknown } | { ok: false; detail: string } {
  const ceiling = outputByteCeiling(job.maxOutputTokens);
  if (value.result !== undefined) {
    if (Buffer.byteLength(JSON.stringify(value.result) ?? "") > ceiling)
      return { ok: false, detail: "output_too_large" };
    return { ok: true, output: value.result };
  }
  const text = (value.text ?? "").trim();
  if (!text) return { ok: false, detail: "empty_output" };
  if (Buffer.byteLength(text) > ceiling) return { ok: false, detail: "output_too_large" };
  if (job.outputFormat !== RunnerOutputFormat.Json) return { ok: true, output: text };
  // A fenced block is the one deviation common enough to recover; anything else fails.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  try {
    return { ok: true, output: JSON.parse(fenced?.[1] ?? text) };
  } catch {
    return { ok: false, detail: "output_not_json" };
  }
}

// ── the box ──────────────────────────────────────────────────────────────────────────────────

/**
 * The sandbox policy one job runs under: reading the home folder denied, bar the job's folder, the
 * CLI's install and Claude Code's own home (which it reads and writes for its sign-in and state).
 * Codex's home is never opened: its shell tool could read its sign-in there.
 */
export function runnerPolicy(install: RunnerInstall, cwd: string, home: string): Partial<SandboxPolicy> {
  const own = install.runner === AiWatcherRunner.Claude ? install.homes : [];
  return {
    denyRead: [home],
    allowRead: [cwd, ...install.readRoots, ...own],
    allowWrite: [cwd, ...own],
    allowedDomains: [...RUNNER_DOMAINS[install.runner]],
  };
}

/** Variables that point a CLI at a metered API or another endpoint, whatever their names say. */
const ENDPOINT_VARIABLE = /^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK$)/;

/**
 * The CLI's environment: the contractor environment (the person's toolchain, no credential, not
 * the other vendor's variables, not even the CLI's own token variable) without any API key or
 * endpoint variable, so the job runs on the plan and nothing else. The CLI's own home variable
 * stays: it is where its sign-in lives, not a key.
 */
export function runnerEnv(
  parent: Readonly<Record<string, string | undefined>>,
  install: Pick<RunnerInstall, "runner">,
  home: string,
): Record<string, string> {
  const env = childEnv({ ...parent }, { base: "contractor", vendor: install.runner, keep: [] });
  for (const name of Object.keys(env)) if (ENDPOINT_VARIABLE.test(name)) delete env[name];
  const claude = install.runner === AiWatcherRunner.Claude;
  return {
    ...env,
    HOME: home,
    // A game's job never updates the person's CLI, and sends nothing beyond the answer it asks for.
    DISABLE_AUTOUPDATER: "1",
    ...(claude ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}),
  };
}

/** The shell line for one CLI invocation, every word quoted. */
const commandOf = (binary: string, argv: readonly string[]): string =>
  [binary, ...argv].map((word) => shellQuote(word)).join(" ");

/** A job's own folder, made empty and private. */
async function jobFolder(tmpRoot: string): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(path.join(tmpRoot, "genex-player-"));
}

// ── one job ──────────────────────────────────────────────────────────────────────────────────

/** The argv for one job in its folder; a Codex schema is written there first. */
async function argvFor(
  job: RunnerJob,
  options: RunJobOptions,
  cwd: string,
): Promise<{ argv: string[]; outFile: string }> {
  const outFile = path.join(cwd, "result.out");
  if (options.install.runner === AiWatcherRunner.Claude)
    return { argv: claudeArgv(job, options.policy.claude), outFile };
  const structured = job.outputFormat === RunnerOutputFormat.Json && job.schema !== undefined;
  const schemaFile = structured ? path.join(cwd, "schema.json") : undefined;
  if (schemaFile) await writeFile(schemaFile, JSON.stringify(job.schema), { mode: 0o600 });
  const files = { cwd, outFile, ...(schemaFile ? { schemaFile } : {}) };
  return { argv: codexArgv(job, options.policy.codex ?? {}, files), outFile };
}

/** What a finished run came to, read from Claude Code's envelope or Codex's out file. */
async function outcomeOf(job: RunnerJob, runner: AiWatcherRunner, result: RunResult, outFile: string) {
  const stderr = result.stderr.slice(-STDERR_TAIL_CHARS);
  if (result.truncated) return { ok: false, release: PlayerRelease.Failed, detail: "output_too_large" };
  if (runner === AiWatcherRunner.Claude) {
    const envelope = parseClaudeEnvelope(result.stdout);
    if (!envelope.ok) {
      const classified = classifyFailure(`${envelope.detail ?? ""} ${envelope.text ?? ""} ${stderr}`);
      return { ok: false, ...classified, detail: envelope.detail ?? "failed" };
    }
    const read = readOutput(envelope, job);
    return read.ok
      ? { ok: true, output: read.output }
      : { ok: false, release: PlayerRelease.Failed, detail: read.detail };
  }
  const text = await readFile(outFile, "utf8").catch(() => "");
  if (result.code !== 0 && !text.trim())
    return { ok: false, ...classifyFailure(`${stderr} exit ${result.code}`), detail: `exit_${result.code}` };
  const read = readOutput({ text }, job);
  return read.ok
    ? { ok: true, output: read.output }
    : { ok: false, release: PlayerRelease.Failed, detail: read.detail };
}

/** Whether `binary` is a file this process may run. */
const runnable = (binary: string): Promise<boolean> =>
  access(binary, constants.X_OK).then(
    () => true,
    () => false,
  );

/** Run `request` in a box made for `cwd`, and give the box back. */
async function inBox(
  factory: RunnerSandboxFactory,
  install: RunnerInstall,
  cwd: string,
  request: RunRequest,
): Promise<RunResult> {
  const ownHome = install.runner === AiWatcherRunner.Claude ? install.homes : [];
  const sandbox = await factory({ cwd, ownHome });
  try {
    return await sandbox.run(request);
  } finally {
    await sandbox.dispose().catch(() => {});
  }
}

/**
 * Run one job and resolve its outcome; never throws, because a failed generation is a normal event
 * on this lane and genex.games is told either way. The job's folder is removed whatever happened.
 */
export async function runJob(job: RunnerJob, options: RunJobOptions): Promise<RunnerOutcome> {
  const started = Date.now();
  const { install } = options;
  const elapsed = () => Date.now() - started;
  // A CLI that is gone is not installed, whatever the shell that would have started it prints.
  if (!(await runnable(install.binary)))
    return { ok: false, release: PlayerRelease.RunnerUnavailable, detail: "missing", durationMs: elapsed() };
  const cwd = await jobFolder(options.tmpRoot);
  try {
    const { argv, outFile } = await argvFor(job, options, cwd);
    options.log(`player: ${install.runner} ${job.model.cliModel} (no tools)`);
    const request: RunRequest = {
      command: commandOf(install.binary, argv),
      cwd,
      env: runnerEnv(options.parentEnv, install, options.home),
      stdin: job.user,
      policy: runnerPolicy(install, cwd, options.home),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      label: `genex-player:${install.runner}`,
      maxOutputBytes: HARD_OUTPUT_BYTES + OUTPUT_SLACK_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const result = await inBox(options.sandbox, install, cwd, request).catch(() => null);
    // The watcher is going away: hand the row straight back rather than wait out its answer.
    if (options.signal?.aborted)
      return { ok: false, release: PlayerRelease.RunnerUnavailable, detail: "shutdown", durationMs: elapsed() };
    if (!result)
      return { ok: false, release: PlayerRelease.RunnerUnavailable, detail: "sandbox", durationMs: elapsed() };
    if (result.timedOut) return { ok: false, release: PlayerRelease.Failed, detail: "timeout", durationMs: elapsed() };
    return { ...(await outcomeOf(job, install.runner, result, outFile)), durationMs: elapsed() };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

// ── the probe that decides whether a CLI is advertised ───────────────────────────────────────

/** Why a CLI is not advertised. Wire values: never rename one. */
export const RunnerProbeFailure = {
  /** A file in the home folder could be read from inside the box. */
  ReadNotDenied: "read-not-denied",
  /** The CLI does not say it is signed in to a plan from inside the box. */
  NotSignedIn: "not-signed-in",
  /** The box could not start on this Mac. */
  SandboxUnavailable: "sandbox-unavailable",
  /** Claude Code loaded a memory file (or gave no answer that shows it did not): the person's would reach a job. */
  MemoryLoaded: "memory-loaded",
} as const;
export type RunnerProbeFailure = (typeof RunnerProbeFailure)[keyof typeof RunnerProbeFailure];

/** What the probe found. */
export type RunnerProbeResult = { ok: true; failure: null } | { ok: false; failure: RunnerProbeFailure };

/** What the probe runs with. */
export interface ProbeOptions {
  sandbox: RunnerSandboxFactory;
  tmpRoot: string;
  home: string;
  parentEnv: Readonly<Record<string, string | undefined>>;
  /** A folder inside the home folder the canary is written to, and removed from. */
  canaryDir: string;
  timeoutMs?: number;
}

/** The CLI's own question "are you signed in", as argv. */
const AUTH_ARGV = {
  [AiWatcherRunner.Claude]: ["auth", "status", "--json"],
  [AiWatcherRunner.Codex]: ["login", "status"],
} as const satisfies Record<AiWatcherRunner, readonly string[]>;

/** Whether the CLI's answer says it is signed in to a plan (Codex on an API key is not a plan). */
function signedIn(runner: AiWatcherRunner, result: RunResult): boolean {
  if (runner === AiWatcherRunner.Claude)
    return parseAuthStatus(result.code ?? 1, result.stdout, result.stderr).loggedIn === true;
  const status = parseCodexAuthStatus(result.code ?? 1, result.stdout, result.stderr);
  return status.loggedIn === true && status.method === "chatgpt";
}

/** One probe run in a fresh box under the runner's policy; null when the box could not start. */
async function probeRun(
  install: RunnerInstall,
  options: ProbeOptions,
  command: string,
  job?: { stdin: string; files: Readonly<Record<string, string>> },
): Promise<RunResult | null> {
  const cwd = await jobFolder(options.tmpRoot);
  try {
    for (const [name, text] of Object.entries(job?.files ?? {}))
      await writeFile(path.join(cwd, name), text, { mode: 0o600 });
    return await inBox(options.sandbox, install, cwd, {
      command,
      cwd,
      env: runnerEnv(options.parentEnv, install, options.home),
      policy: runnerPolicy(install, cwd, options.home),
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      label: `genex-player-probe:${install.runner}`,
      ...(job ? { stdin: job.stdin } : {}),
    }).catch(() => null);
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/** The memory step's job: the smallest text job, on the plan's quickest model. */
const MEMORY_PROBE_JOB: RunnerJob = {
  system: MEMORY_PROBE_SYSTEM,
  user: MEMORY_PROBE_PROMPT,
  outputFormat: RunnerOutputFormat.Text,
  model: { id: "anthropic/claude-haiku-4.5", family: PlayerProvider.Claude, cliModel: "haiku" },
  maxOutputTokens: 256,
  mode: RunnerMode.OneTime,
  grantId: null,
  leaseSeconds: 60,
};

/**
 * Claude Code's memory step: a job's own invocation, in a folder whose `CLAUDE.md` holds a canary,
 * asked what it was told. The same switch that keeps this file out keeps the person's own
 * `~/.claude/CLAUDE.md` and settings out, and the person's own files are never written to. A run
 * that gives no answer proves nothing, so it fails too.
 */
async function memoryStays(install: RunnerInstall, options: ProbeOptions): Promise<boolean | null> {
  const secret = randomUUID();
  const argv = claudeArgv(MEMORY_PROBE_JOB, FALLBACK_POLICY.claude);
  const run = await probeRun(install, options, commandOf(install.binary, argv), {
    stdin: MEMORY_PROBE_JOB.user,
    files: { "CLAUDE.md": memoryCanary(secret) },
  });
  if (!run) return null;
  const envelope = parseClaudeEnvelope(run.stdout);
  return envelope.ok && !run.stdout.includes(secret);
}

/**
 * Whether a CLI may be advertised: under the policy its jobs run with, a canary written in the
 * home folder must stay unreadable, the CLI must still say it is signed in, and Claude Code must
 * answer a job without a memory file's canary in it. Never throws.
 */
export async function probeRunner(install: RunnerInstall, options: ProbeOptions): Promise<RunnerProbeResult> {
  const secret = randomUUID();
  await mkdir(options.canaryDir, { recursive: true });
  const canary = path.join(options.canaryDir, `canary-${randomUUID()}`);
  await writeFile(canary, secret, { mode: 0o600 });
  try {
    const read = await probeRun(install, options, commandOf("cat", [canary]));
    if (!read) return { ok: false, failure: RunnerProbeFailure.SandboxUnavailable };
    if (read.code === 0 || read.stdout.includes(secret))
      return { ok: false, failure: RunnerProbeFailure.ReadNotDenied };
    const auth = await probeRun(install, options, commandOf(install.binary, AUTH_ARGV[install.runner]));
    if (!auth) return { ok: false, failure: RunnerProbeFailure.SandboxUnavailable };
    if (!signedIn(install.runner, auth)) return { ok: false, failure: RunnerProbeFailure.NotSignedIn };
    if (install.runner !== AiWatcherRunner.Claude) return { ok: true, failure: null };
    const stays = await memoryStays(install, options);
    if (stays === null) return { ok: false, failure: RunnerProbeFailure.SandboxUnavailable };
    return stays ? { ok: true, failure: null } : { ok: false, failure: RunnerProbeFailure.MemoryLoaded };
  } finally {
    await rm(canary, { force: true }).catch(() => {});
  }
}

// ── finding a CLI's install ──────────────────────────────────────────────────────────────────

/** The part of a path before its `node_modules` folder (an npm prefix's `lib` too), or null. */
function packagePrefix(file: string): string | null {
  const parts = file.split(path.sep);
  const at = parts.indexOf("node_modules");
  if (at <= 0) return null;
  const prefix = parts.slice(0, parts[at - 1] === "lib" ? at - 1 : at).join(path.sep);
  return prefix || null;
}

/** The first bytes of a file (a native CLI is hundreds of megabytes: never read whole). */
async function readHead(file: string): Promise<string> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(SHEBANG_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SHEBANG_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The interpreter a script's `#!` line runs, resolved on `PATH` when it goes through `env`. */
async function interpreterOf(file: string, pathValue: string | undefined): Promise<string | null> {
  const head = await readHead(file);
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(head);
  if (!shebang?.[1]) return null;
  const named = path.basename(shebang[1]) === "env" ? shebang[2] : shebang[1];
  if (!named) return null;
  if (path.isAbsolute(named)) return realpath(named).catch(() => null);
  for (const dir of (pathValue ?? "").split(path.delimiter).filter(Boolean)) {
    const found = await realpath(path.join(dir, named)).catch(() => null);
    if (found) return found;
  }
  return null;
}

/** The folders a CLI's install spans: where it was found, its real file's folder and package prefix, and its interpreter's. */
export async function installRoots(binary: string, pathValue: string | undefined): Promise<string[]> {
  const real = await realpath(binary).catch(() => binary);
  const interpreter = await interpreterOf(real, pathValue);
  const roots = [path.dirname(binary), path.dirname(real), packagePrefix(real)];
  if (interpreter)
    roots.push(path.dirname(interpreter), packagePrefix(interpreter) ?? path.dirname(path.dirname(interpreter)));
  return [...new Set(roots.filter((root): root is string => Boolean(root)))];
}

/** Claude Code's own homes: its config folder and the state file beside the home folder. */
export function claudeHomes(env: Readonly<Record<string, string | undefined>>, home: string): string[] {
  const configured = env.CLAUDE_CONFIG_DIR;
  const dir = configured && path.isAbsolute(configured) ? configured : path.join(home, ".claude");
  return [dir, path.join(home, ".claude.json")];
}

/** Codex's own home, which its jobs never see. */
export function codexHomes(env: Readonly<Record<string, string | undefined>>, home: string): string[] {
  const configured = env.CODEX_HOME;
  return [configured && path.isAbsolute(configured) ? configured : path.join(home, ".codex")];
}

/** The install record for a CLI found at `binary`. */
export async function runnerInstall(
  runner: AiWatcherRunner,
  binary: string,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Promise<RunnerInstall> {
  const homes = runner === AiWatcherRunner.Claude ? claudeHomes(env, home) : codexHomes(env, home);
  return { runner, binary, readRoots: await installRoots(binary, env.PATH), homes };
}
