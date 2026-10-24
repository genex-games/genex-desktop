/**
 * What the studio reads from the `grok` CLI (Grok Build) outside a session, and how it starts one.
 *
 * Grok Build keeps its own sign-in (`grok login`, a Grok account in the browser) in its home,
 * which the studio never reads. Whether it is signed in, and the models it can run, the studio
 * asks the CLI itself: `grok agent stdio` speaks the Agent Client Protocol (JSON-RPC on stdin and
 * stdout), and its `_x.ai/auth/info` and `_x.ai/models/list` methods answer in typed fields
 * without opening a session or calling a model (`probeGrok`). Sessions run through its headless
 * mode instead (`grok.ts`): one `grok --prompt-file … --output-format streaming-json` per turn,
 * resumed by its session id.
 * Recorded answers: `tests/fixtures/transcripts/grok-probe-*.jsonl` (Grok Build 1.0.70).
 */
import path from "node:path";
import { createInterface } from "node:readline";
import { CatalogError } from "./model-catalog.ts";
import { ModelContextSource, type EngineModel } from "./types.ts";
import { spawnCommand } from "../command-launch.ts";
import { stopChild } from "../process-tree.ts";
import type { SandboxOptions } from "../spawn.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";
import { t } from "../../shared/i18n.ts";

/** How long the probe may take: its model list may come from xAI first. */
export const PROBE_TIMEOUT_MS = 20 * SECOND_MS;
/** A reply may use this many tokens: the CLI's catalog gives no output limit. */
const DEFAULT_REPLY_TOKENS = 32_768;
/** A model whose context the catalog does not give: the CLI's own default for a model it does not know. */
const DEFAULT_CONTEXT_TOKENS = 200_000;
/** The ACP version the probe speaks. */
const ACP_PROTOCOL_VERSION = 1;

/** The probe's JSON-RPC requests, by id: `initialize` first, then the two questions. */
const ProbeRequest = {
  Initialize: 1,
  AuthInfo: 2,
  Models: 3,
} as const;

/** Grok Build's ACP methods the probe calls. Its wire spelling: never rename a value. */
export const GrokMethod = {
  Initialize: "initialize",
  AuthInfo: "_x.ai/auth/info",
  ModelsList: "_x.ai/models/list",
} as const;

/**
 * How Grok Build is signed in (`_x.ai/auth/info` `methodId`): its own sign-in (`grok login`,
 * kept in its home) or an xAI API key from its config. Its wire spelling: never rename a value.
 */
export const GrokAuthMethod = {
  CachedToken: "cached_token",
  ApiKey: "xai.api_key",
} as const;

/** The hosts a Grok session reaches: xAI's API, Grok's session service, and its sign-in's refresh. */
export const GROK_HOSTS = ["api.x.ai", "cli-chat-proxy.grok.com", "auth.x.ai", "accounts.x.ai", "grok.com"] as const;

/** What a session's tools may do: a build edits; a read-only session, a lead while its build runs and Plan only look. */
export const GrokAccess = {
  /** A build: edits and commands in its workspace. */
  Build: "build",
  /** A read-only session (a judge, a lead while its build runs, Plan): reads, and runs only the studio bridge. */
  ReadOnly: "read-only",
  /** A judge that plays: reads no file at all, and reaches the build only through the studio's tools. */
  Blind: "blind",
  /** A one-shot answer (`complete`): no tool at all. */
  Answer: "answer",
} as const;
export type GrokAccess = (typeof GrokAccess)[keyof typeof GrokAccess];

/** The studio bridge's command, as Grok's `Bash(…)` permission rule matches it. */
const BRIDGE_RULE = "Bash(node .studio/bridge/tool.mjs *)";
/**
 * Tools no studio session runs: a question nobody is there to answer, Grok's own plan mode (the
 * studio's Plan is a read-only session), background schedulers and workflows that outlive the turn,
 * and feedback to xAI.
 */
const NEVER_TOOLS = [
  "ask_user_question",
  "enter_plan_mode",
  "exit_plan_mode",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "monitor",
  "workflow",
  "send_feedback",
] as const;
/** The tools that change files; a read-only session goes without them. */
const EDIT_TOOLS = ["search_replace", "write", "image_edit"] as const;
/** What a one-shot answer goes without besides: commands, helpers and making pictures or video. */
const ANSWER_TOOLS = [
  "run_terminal_command",
  "spawn_subagent",
  "image_gen",
  "image_to_video",
  "reference_to_video",
] as const;
/** A blind judge's only tool: the shell, which runs nothing but the studio bridge. */
const BLIND_TOOLS = "run_terminal_command";

/** The tools each kind of session goes without, beyond those none runs. */
const REMOVED_TOOLS: Record<GrokAccess, readonly string[]> = {
  build: [],
  "read-only": EDIT_TOOLS,
  blind: EDIT_TOOLS,
  answer: [...EDIT_TOOLS, ...ANSWER_TOOLS],
};

/** What the probe says in Settings when it could not be read, in the person's language. */
const MESSAGE = {
  Malformed: () => t("Grok Build's model list could not be read."),
  Silent: "grok agent did not answer",
  Exited: (code: number | null) => `grok agent exited with ${code}`,
} as const;

/** Whose sign-in Grok Build runs on, as it says. */
export interface GrokAccount {
  /** `GrokAuthMethod`, or null while it is not signed in. */
  method: string | null;
  email: string | null;
  /** Why xAI blocked the account, in its words, when it did. */
  blocked: string | null;
}

/** What one probe found. */
export interface GrokProbe {
  account: GrokAccount;
  models: EngineModel[];
}

type Record_ = Record<string, unknown>;

const record = (value: unknown): Record_ =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : {};

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** One line as a JSON-RPC answer (an id and no method), or null for a notification or stray output. */
function answerOf(line: string): Record_ | null {
  let message: Record_;
  try {
    message = record(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
  return typeof message.id === "number" && message.method === undefined ? message : null;
}

/** The request a line answers, or null. */
function answerId(line: string): number | null {
  const id = answerOf(line)?.id;
  return typeof id === "number" ? id : null;
}

/** The probe's answers, by request id. */
function answers(lines: readonly string[]): Map<number, Record_> {
  const found = new Map<number, Record_>();
  for (const line of lines) {
    const answer = answerOf(line);
    if (answer) found.set(Number(answer.id), answer);
  }
  return found;
}

/** The probe's transcript, read: whose sign-in, and the models Grok Build offers. */
export function parseGrokProbe(lines: readonly string[]): GrokProbe {
  const answered = answers(lines);
  const init = record(answered.get(ProbeRequest.Initialize)?.result);
  const auth = answered.get(ProbeRequest.AuthInfo);
  const models = answered.get(ProbeRequest.Models);
  if (!auth?.result || !models?.result) throw new CatalogError(ModelCatalogProblemCode.Provider, MESSAGE.Malformed());
  const info = record(auth.result);
  const vision = record(record(init.agentCapabilities).promptCapabilities).image === true;
  return {
    account: { method: text(info.methodId), email: text(info.email), blocked: text(info.userBlockedReason) },
    models: modelRows(record(record(models.result).result), vision),
  };
}

/** `_x.ai/models/list`'s models as rows; its current model is the CLI's default. */
function modelRows(list: Record_, vision: boolean): EngineModel[] {
  const current = text(list.currentModelId);
  const listed = Array.isArray(list.availableModels) ? list.availableModels.map(record) : [];
  return listed.flatMap((model) => {
    const id = text(model.modelId);
    return id ? [modelRow(id, model, { vision, providerDefault: id === current })] : [];
  });
}

/** Effort levels from least to most, for the composer's dial. */
const EFFORT_ORDER: readonly string[] = [
  ReasoningEffort.None,
  ReasoningEffort.Minimal,
  ReasoningEffort.Low,
  ReasoningEffort.Medium,
  ReasoningEffort.High,
  ReasoningEffort.Xhigh,
  ReasoningEffort.Max,
];

function modelRow(id: string, model: Record_, facts: { vision: boolean; providerDefault: boolean }): EngineModel {
  const meta = record(model._meta);
  const context = meta.totalContextTokens;
  const known = typeof context === "number" && Number.isFinite(context) && context > 0;
  const levels = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts.map(record) : [];
  const efforts = levels
    .flatMap((level) => (text(level.id) ? [String(level.id)] : []))
    .sort((a, b) => effortRank(a) - effortRank(b));
  const chosen = text(levels.find((level) => level.default === true)?.id) ?? text(meta.reasoningEffort);
  return {
    id,
    label: text(model.name) ?? id,
    contextWindow: known ? context : DEFAULT_CONTEXT_TOKENS,
    contextSource: known ? ModelContextSource.Catalog : ModelContextSource.Unknown,
    maxTokens: DEFAULT_REPLY_TOKENS,
    supportsTools: true,
    supportsVision: facts.vision,
    supportsThinking: true,
    ...(facts.providerDefault ? { providerDefault: true } : {}),
    ...(text(model.description) ? { note: String(model.description) } : {}),
    ...(efforts.length ? { efforts, ...(chosen && efforts.includes(chosen) ? { defaultEffort: chosen } : {}) } : {}),
  };
}

/** Where an effort stands among the levels; one the studio does not know goes last. */
function effortRank(effort: string): number {
  const rank = EFFORT_ORDER.indexOf(effort);
  return rank < 0 ? EFFORT_ORDER.length : rank;
}

/**
 * Ask `grok agent stdio` who is signed in and which models it offers: `initialize`, then
 * `_x.ai/auth/info` and `_x.ai/models/list`. No session opens and no model is called. Runs on the
 * host, as the person's own terminal would; its stdin closes and it stops once both answered.
 */
export async function probeGrok(
  binary: string,
  options: { env: Record<string, string>; cwd: string; timeoutMs?: number },
): Promise<GrokProbe> {
  const child = spawnCommand(binary, ["agent", "stdio"], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const deadline = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
  const send = (id: number, method: string, params: Record_): void => {
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  };
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("close", (code) => reject(new Error(MESSAGE.Exited(code))));
  });
  const read = (async () => {
    if (!child.stdout) throw new Error(MESSAGE.Silent);
    const lines: string[] = [];
    const answered = new Set<number>();
    send(ProbeRequest.Initialize, GrokMethod.Initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    for await (const line of createInterface({ input: child.stdout, signal: deadline })) {
      lines.push(line);
      const id = answerId(line);
      if (id === null) continue;
      answered.add(id);
      // The questions go once Grok answered `initialize`, as ACP asks.
      if (id === ProbeRequest.Initialize) {
        send(ProbeRequest.AuthInfo, GrokMethod.AuthInfo, {});
        send(ProbeRequest.Models, GrokMethod.ModelsList, {});
      }
      if (answered.has(ProbeRequest.AuthInfo) && answered.has(ProbeRequest.Models)) return parseGrokProbe(lines);
    }
    throw new Error(MESSAGE.Silent);
  })();
  try {
    return await Promise.race([read, exited]);
  } finally {
    child.stdin?.end();
    await stopChild(child, { signal: "SIGTERM" }).catch(() => {});
  }
}

/** What one `grok` turn is started with. */
export interface GrokTurn {
  access: GrokAccess;
  /** The file holding the turn's prompt as ACP content blocks. */
  promptFile: string;
  cwd: string;
  model?: string | undefined;
  /** An effort the model lists; none is passed for a model without a dial. */
  effort?: string | null | undefined;
  resume?: string | undefined;
  /** The session reaches the studio's tools through the file bridge. */
  bridge: boolean;
}

/**
 * `grok`'s arguments for one turn. Grok's own sandbox stays off: the studio's holds every session.
 * A build approves every call; so does a read-only session, whose sandbox lets it write only its
 * own folder (as a Codex reviewer's does), with the file-editing tools gone. A blind judge and a
 * one-shot answer run in Grok's ask mode, where a headless run refuses every call nobody approved
 * and ends the turn there: a blind judge has the shell alone, approved for the studio bridge only.
 * Background work never outlives the turn.
 */
export function grokTurnArgv(turn: GrokTurn): string[] {
  const asks = turn.access === GrokAccess.Blind || turn.access === GrokAccess.Answer;
  const blind = turn.access === GrokAccess.Blind;
  const removed = [...NEVER_TOOLS, ...REMOVED_TOOLS[turn.access]];
  return [
    "--prompt-file",
    turn.promptFile,
    "--output-format",
    "streaming-json",
    "--cwd",
    turn.cwd,
    "--sandbox",
    "off",
    "--no-wait-for-background",
    ...(asks ? bridgeRule(blind && turn.bridge) : ["--always-approve"]),
    ...(blind ? ["--tools", BLIND_TOOLS] : []),
    "--disallowed-tools",
    removed.join(","),
    ...(asks ? ["--disable-web-search"] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    ...(turn.resume ? ["--resume", turn.resume] : []),
  ];
}

/** A blind judge approves the studio bridge alone, when it has one. */
function bridgeRule(bridge: boolean): string[] {
  return bridge ? ["--allow", BRIDGE_RULE] : [];
}

/** `grok`'s arguments for Compact Now: its own `/compact` on the resumed session, and no turn. */
export function grokCompactArgv(resume: string, cwd: string): string[] {
  return [
    "-p",
    "/compact",
    "--resume",
    resume,
    "--output-format",
    "streaming-json",
    "--cwd",
    cwd,
    "--sandbox",
    "off",
    "--no-wait-for-background",
  ];
}

/**
 * The variables every `grok` run starts with, over the contractor's environment (which never
 * carries an xAI key: a session runs on the person's own Grok sign-in). Its home is named outright,
 * so the sign-in is found whoever the sandbox runs it as (on Windows, the sandbox's own user). It
 * never updates itself, keeps no memory between games, and loads none of the person's Claude or
 * Cursor MCP servers, hooks or skills; its error log names the HTTP status of a failed call.
 */
export function grokEnv(home: string): Record<string, string> {
  return {
    GROK_HOME: home,
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_MEMORY: "0",
    GROK_WORKFLOWS: "0",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CLAUDE_HOOKS_ENABLED: "0",
    GROK_CLAUDE_SKILLS_ENABLED: "0",
    GROK_CURSOR_MCPS_ENABLED: "0",
    GROK_CURSOR_HOOKS_ENABLED: "0",
    GROK_CURSOR_SKILLS_ENABLED: "0",
    RUST_LOG: "error",
    NO_COLOR: "1",
  };
}

/** The sandbox a session runs in: the folder it works in, Grok's own home, and nothing it must not read. */
export function grokSandbox(input: {
  runDir: string;
  gameDir: string;
  gitDirs: string[];
  scratchDir: string;
  secretPaths: string[];
  home: string;
  toolPath?: () => Promise<string>;
}): SandboxOptions {
  return {
    writableRoots: [input.runDir, ...input.gitDirs],
    scratchDir: input.scratchDir,
    secretPaths: input.secretPaths,
    ownHome: [input.home],
    // A game's own Grok settings (its MCP servers, permissions and hooks) are never the session's to plant.
    denyWrite: [path.join(input.gameDir, ".grok")],
    ...(input.toolPath ? { toolPath: input.toolPath } : {}),
  };
}

/** A turn's prompt as the ACP content blocks `--prompt-file` takes: the words, then each picture. */
export function grokPromptBlocks(words: string, images: ReadonlyArray<{ data: string; mimeType: string }>): string {
  return JSON.stringify([
    { type: "text", text: words },
    ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
  ]);
}
