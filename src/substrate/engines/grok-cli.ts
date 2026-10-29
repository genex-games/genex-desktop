/**
 * What the studio reads from the `grok` CLI (Grok Build) outside a session, and how it starts one.
 *
 * Grok Build keeps its own sign-in (`grok login`, a Grok account in the browser) in its home,
 * which the studio only copies for a session on Windows (`copySessionSignIn`). Whether it is
 * signed in, and the models it can run, the studio asks the CLI itself: `grok agent stdio` speaks
 * the Agent Client Protocol (JSON-RPC on stdin and stdout), and its `_x.ai/auth/info` and
 * `_x.ai/models/list` methods answer in typed fields without opening a session or calling a model
 * (`probeGrok`). Sessions run through its headless mode instead (`grok.ts`): one `grok
 * --prompt-file … --output-format streaming-json` per turn, resumed by its session id.
 * Recorded answers: `tests/fixtures/transcripts/grok-probe-*.jsonl` (Grok Build 1.0.70).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { picturesNote } from "./grok-prompts.ts";
import { CatalogError } from "./model-catalog.ts";
import { ModelContextSource, type EngineModel } from "./types.ts";
import { spawnCommand } from "../command-launch.ts";
import { stopChild } from "../process-tree.ts";
import type { SandboxOptions } from "../spawn.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
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
/** The oldest Grok Build xAI's API serves: an older CLI is refused with 426 Upgrade Required. */
export const GROK_MIN_VERSION = "1.0.13";
/** The HTTP status xAI refuses an outdated CLI with. */
export const GROK_OUTDATED_STATUS = 426;
/** Grok Build's sign-in, one entry per account, in its home. */
const AUTH_FILE = "auth.json";
/** What an account's entry renews its access token with. Grok's own spelling: never rename it. */
const REFRESH_TOKEN = "refresh_token";
/** When an account's access token stops working (RFC 3339). Grok's own spelling. */
const EXPIRES_AT = "expires_at";
/** When an account's access token was minted (RFC 3339). Grok's own spelling. */
const CREATE_TIME = "create_time";
/**
 * How many seconds before its expiry Grok counts a sign-in due for renewal. Grok's own variable, meant
 * for its tests; its default is `GROK_EARLY_RENEWAL_SECONDS`.
 */
const EARLY_RENEWAL_VARIABLE = "GROK_AUTH_EARLY_INVALIDATION_SECS";
/** Grok's own lead: it renews a sign-in five minutes before it expires. */
const GROK_EARLY_RENEWAL_SECONDS = 300;
/** How far past the token's expiry the lead reaches, so Grok counts it due however late it starts. */
const RENEWAL_LEAD_MARGIN_SECONDS = 60;
/**
 * How long a session's copy of the sign-in should still work, as it renews nothing: a token is
 * renewed with this long left, or half its life when that is less, so the lead that makes it due
 * always stays short of a new token's life and Grok never counts the new one due too.
 */
export const SESSION_SIGN_IN_HOLD_MS = 2 * HOUR_MS;
/** How long a run waits on the renewal before it gets what is there; the renewal goes on without it. */
const RENEWAL_WAIT_MS = 20 * SECOND_MS;
/** How long the person's own Grok gets to renew before its input closes: a run's wait never cuts it. */
const RENEWAL_CAP_MS = 2 * MINUTE_MS;
/** How often the sign-in is looked at while Grok renews it. */
const RENEWAL_POLL_MS = 250;
/** How long Grok gets to exit on its own once its input closes, before it is stopped. */
const RENEWAL_EXIT_GRACE_MS = 3 * SECOND_MS;

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
 * studio's Plan is a read-only session) and goal (no turn sets one, so marking it done only fails),
 * background schedulers and workflows that outlive the turn, and feedback to xAI.
 */
const NEVER_TOOLS = [
  "ask_user_question",
  "enter_plan_mode",
  "exit_plan_mode",
  "update_goal",
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

const isRecord = (value: unknown): value is Record_ =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const record = (value: unknown): Record_ => (isRecord(value) ? value : {});

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

/** Is this `grok --version` line older than xAI serves? An unreadable one is left to the CLI. */
export function grokTooOld(version: string | undefined): boolean {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!found) return false;
  const minimum = GROK_MIN_VERSION.split(".").map(Number);
  const parts = found.slice(1).map(Number);
  for (const [index, part] of parts.entries()) {
    const floor = minimum[index] ?? 0;
    if (part !== floor) return part < floor;
  }
  return false;
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
 * so its sessions and settings are found whoever the sandbox runs it as (on Windows, the sandbox's
 * own user, which reads a copy of the sign-in instead: `copySessionSignIn`). It
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

/** Grok's sign-in file read as its accounts by scope, or null when it is no JSON object. */
function signInStore(text: string): Record_ | null {
  try {
    const store: unknown = JSON.parse(text);
    return isRecord(store) ? store : null;
  } catch {
    return null;
  }
}

/**
 * Grok Build's sign-in (`auth.json`) as a session run as another user holds it: every account's
 * entry without its refresh token, so the session calls xAI with the access token it finds and can
 * never renew it. xAI takes each refresh token once, and a renewal kept in the session's copy
 * would leave the person's own sign-in holding a spent one. Null for a file that is no such sign-in.
 */
export function sessionSignIn(text: string): string | null {
  const store = signInStore(text);
  if (!store) return null;
  const accounts = Object.entries(store);
  if (!accounts.every(([, entry]) => isRecord(entry))) return null;
  const kept = accounts.map(([scope, entry]) => [
    scope,
    Object.fromEntries(Object.entries(record(entry)).filter(([field]) => field !== REFRESH_TOKEN)),
  ]);
  return JSON.stringify(Object.fromEntries(kept));
}

/**
 * Grok's sign-in in `home`, copied into `folder` for a session the Windows sandbox runs as its own
 * user (`sessionSignIn`): Grok gives its file to the Windows user who signed in alone, on every
 * read and write, so that user never opens the original. The session reads the copy through
 * `GROK_AUTH_PATH`. Null, and nothing written, when there is no sign-in to copy.
 */
export async function copySessionSignIn(home: string, folder: string): Promise<string | null> {
  const text = await readSignIn(home);
  const store = text === null ? null : sessionSignIn(text);
  if (store === null) return null;
  const copy = path.join(folder, AUTH_FILE);
  await writeFile(copy, store, { encoding: "utf8", flag: "wx" });
  return copy;
}

/** Which account of Grok's sign-in to renew, and how early Grok must count it due to renew it now. */
export interface SignInRenewal {
  scope: string;
  leadSeconds: number;
}

/**
 * The renewal Grok's sign-in needs before a session copies it: the account with a refresh token
 * that expires first, when it has less than `SESSION_SIGN_IN_HOLD_MS` (or half its life) left, with
 * a lead that reaches past its expiry. Null when every such account holds, or none can be renewed.
 */
export function signInRenewal(text: string, now: number): SignInRenewal | null {
  const store = signInStore(text);
  if (!store) return null;
  const due = Object.entries(store)
    .flatMap(([scope, entry]) => {
      const left = dueLeft(entry, now);
      return left === null ? [] : [{ scope, left }];
    })
    .sort((a, b) => a.left - b.left)[0];
  if (!due) return null;
  const leadSeconds = Math.max(
    GROK_EARLY_RENEWAL_SECONDS,
    Math.ceil(due.left / SECOND_MS) + RENEWAL_LEAD_MARGIN_SECONDS,
  );
  return { scope: due.scope, leadSeconds };
}

/** How long a renewable account's token has left when it is due for renewal; null when it holds or can't be renewed. */
function dueLeft(entry: unknown, now: number): number | null {
  if (!isRecord(entry) || typeof entry[REFRESH_TOKEN] !== "string") return null;
  const expires = Date.parse(String(entry[EXPIRES_AT]));
  const created = Date.parse(String(entry[CREATE_TIME]));
  if (Number.isNaN(expires) || Number.isNaN(created)) return null;
  const left = expires - now;
  return left < Math.min(SESSION_SIGN_IN_HOLD_MS, (expires - created) / 2) ? left : null;
}

/** When an account's access token in Grok's sign-in expires, or null when the file does not say. */
function accountExpiry(text: string | null, scope: string): number | null {
  const entry = text === null ? undefined : signInStore(text)?.[scope];
  const expires = isRecord(entry) ? Date.parse(String(entry[EXPIRES_AT])) : Number.NaN;
  return Number.isNaN(expires) ? null : expires;
}

/** Grok's sign-in in `home` as text, or null when there is none to read. */
export async function readSignIn(home: string): Promise<string | null> {
  return readFile(path.join(home, AUTH_FILE), "utf8").catch(() => null);
}

/**
 * Has the person's own Grok renew one account of its sign-in in `home`, run on the host as the
 * person's terminal would: `grok agent stdio` renews a due sign-in within a second of starting,
 * writing Grok's own file under Grok's own lock, and the renewal's lead makes the account about to
 * expire due. No session opens and no model is called. Resolves once that account's token was
 * renewed, or after `waitMs` with the file as it is; Grok keeps renewing until `capMs`, since
 * stopping it between xAI's answer and its write would leave a spent refresh token, and its input
 * then closes, the process stopped only if it does not exit on its own.
 */
export async function renewGrokSignIn(
  binary: string,
  options: {
    env: Record<string, string>;
    cwd: string;
    home: string;
    renewal: SignInRenewal;
    waitMs?: number;
    capMs?: number;
  },
): Promise<void> {
  const { scope, leadSeconds } = options.renewal;
  const before = accountExpiry(await readSignIn(options.home), scope);
  const child = spawnCommand(binary, ["agent", "stdio"], {
    cwd: options.cwd,
    env: { ...options.env, [EARLY_RENEWAL_VARIABLE]: String(leadSeconds) },
    stdio: ["pipe", "ignore", "ignore"],
  });
  let exited = false;
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  }).then(() => {
    exited = true;
  });
  const renewed = async (): Promise<void> => {
    const cap = Date.now() + (options.capMs ?? RENEWAL_CAP_MS);
    while (!exited && Date.now() < cap) {
      await sleep(RENEWAL_POLL_MS);
      const after = accountExpiry(await readSignIn(options.home), scope);
      if (after !== null && (before === null || after > before)) return;
    }
  };
  const done = renewed()
    .finally(async () => {
      child.stdin?.end();
      await within(closed, RENEWAL_EXIT_GRACE_MS);
      await stopChild(child, { signal: "SIGTERM" }).catch(() => {});
    })
    .catch(() => {});
  await within(done, options.waitMs ?? RENEWAL_WAIT_MS);
}

/** Waits for `work`, or `ms` if that comes first; the timer goes either way. */
async function within(work: Promise<void>, ms: number): Promise<void> {
  const timer = new AbortController();
  await Promise.race([work, sleep(ms, undefined, { signal: timer.signal }).catch(() => {})]);
  timer.abort();
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

/**
 * A turn's prompt as the ACP content blocks `--prompt-file` takes: one text block, the words and
 * then the picture files Grok Build opens itself (it drops a picture block).
 */
export function grokPromptBlocks(words: string, pictures: readonly string[]): string {
  const text = pictures.length ? `${words}\n\n${picturesNote(pictures)}` : words;
  return JSON.stringify([{ type: "text", text }]);
}
