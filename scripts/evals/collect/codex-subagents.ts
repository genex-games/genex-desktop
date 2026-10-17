/**
 * Codex rollouts: `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, one per thread. A
 * sub-agent's rollout names its parent in `session_meta` (`parent_thread_id`), so a run's threads
 * are the main thread and every rollout that chains to it (Rule 13). Each rollout gives:
 *
 * - its model calls: one per `token_count` whose running `total_token_usage` grew, with that
 *   response's `last_token_usage` (normalized: cached tokens out of input) and the model's
 *   `model_context_window`, so the calls sum to the rollout's final total;
 * - the main-loop model from `turn_context.model` (Rule 16) and the served effort;
 * - its tool calls (sub-agents only reach the timeline this way), paired by `call_id`;
 * - `compacted` rows.
 *
 * A sub-agent rollout replays its parent's first records after its own `session_meta`; only the
 * first `session_meta` is the rollout's own. Rollout times are the CLI's own timestamps: a
 * rollout is a file, not a stream.
 */
import fs from "node:fs";
import path from "node:path";
import type { TokenUsage } from "../../../src/shared/eval-lane.ts";
import { isInside } from "../../../src/substrate/paths.ts";
import { codexUsage } from "./codex-stream.ts";
import {
  arrayField,
  epochMs,
  numberField,
  parseObject,
  recordField,
  stringField,
  type TraceReading,
} from "./honesty.ts";
import type { CompactionEvent, ModelCallEvent, ObservationEvent, SessionRef, ToolCallEvent } from "./observation.ts";
import { classifyTool } from "../../../src/shared/tool-category.ts";
import { promptTokens, sumUsage } from "./usage.ts";
import { ObservationEventKind, ObservationSource, ServedModelRole } from "../vocabulary.ts";

/** How deep below `sessions/` rollouts are looked for (`yyyy/mm/dd` is three). */
const MAX_SESSION_DEPTH = 4;
const SESSIONS_DIR = "sessions";
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;

/** The rollout row types and payload types this reader uses (Codex's wire spelling). */
const Row = {
  SessionMeta: "session_meta",
  TurnContext: "turn_context",
  EventMsg: "event_msg",
  ResponseItem: "response_item",
  Compacted: "compacted",
} as const;
const TOKEN_COUNT = "token_count";
const TOOL_CALLS: ReadonlySet<string> = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const TOOL_OUTPUTS: ReadonlySet<string> = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
]);

/** One rollout, read. */
export interface RolloutReading {
  /** The file's basename, never its whole path. */
  file: string;
  sessionId: string | null;
  parentSessionId: string | null;
  cwd: string | null;
  cliVersion: string | null;
  startedAtMs: number | null;
  model: string | null;
  effort: string | null;
  finalUsage: TokenUsage | null;
  calls: ModelCallEvent[];
  tools: ToolCallEvent[];
  compactions: CompactionEvent[];
  trace: TraceReading;
}

interface RolloutState {
  reading: RolloutReading;
  promptAtMs: number;
  lastTotal: number;
  metaSeen: boolean;
  tools: Map<string, ToolCallEvent>;
}

const session = (reading: RolloutReading): SessionRef => ({
  sessionId: reading.sessionId ?? reading.file,
  parentSessionId: reading.parentSessionId,
  role: reading.parentSessionId ? ServedModelRole.Subagent : ServedModelRole.Main,
});

function readMeta(state: RolloutState, payload: Record<string, unknown>, atMs: number | null): void {
  if (state.metaSeen) return;
  state.metaSeen = true;
  const spawn = recordField(recordField(recordField(payload, "source"), "subagent"), "thread_spawn");
  const { reading } = state;
  reading.sessionId = stringField(payload, "id") ?? stringField(payload, "session_id");
  reading.parentSessionId = stringField(payload, "parent_thread_id") ?? stringField(spawn, "parent_thread_id");
  reading.cwd = stringField(payload, "cwd");
  reading.cliVersion = stringField(payload, "cli_version");
  reading.startedAtMs = epochMs(payload.timestamp) ?? atMs;
}

function readTurnContext(state: RolloutState, payload: Record<string, unknown>): void {
  const settings = recordField(recordField(payload, "collaboration_mode"), "settings");
  state.reading.model = stringField(payload, "model") ?? state.reading.model;
  state.reading.effort =
    stringField(payload, "effort") ?? stringField(settings, "reasoning_effort") ?? state.reading.effort;
}

function readTokenCount(state: RolloutState, payload: Record<string, unknown>, atMs: number): void {
  const info = recordField(payload, "info");
  const total = recordField(info, "total_token_usage");
  const totalTokens = numberField(total, "total_tokens");
  if (!total || totalTokens === null || totalTokens <= state.lastTotal) return;
  state.lastTotal = totalTokens;
  const { reading } = state;
  reading.finalUsage = codexUsage(total);
  const usage = codexUsage(recordField(info, "last_token_usage"));
  reading.calls.push({
    kind: ObservationEventKind.ModelCall,
    atMs,
    source: ObservationSource.Transcript,
    id: `${reading.sessionId ?? reading.file}#${totalTokens}`,
    session: session(reading),
    model: reading.model ?? "",
    usage,
    contextTokens: promptTokens(usage),
    contextWindow: numberField(info, "model_context_window"),
    effortServed: reading.effort,
    endMs: null,
    ttftMs: null,
  });
}

/** A shell's `-c`/`-lc` flag: the argument after it is the whole command. */
const SHELL_COMMAND_FLAG = /^-l?c$/;

/**
 * The command a shell-like call ran: `command` as an argv array (`["bash", "-lc", "npm test"]`
 * is `npm test`) or a string, or `cmd`.
 */
function commandOf(payload: Record<string, unknown>): string | null {
  const action = recordField(payload, "action");
  const args = parseObject(stringField(payload, "arguments") ?? "");
  const holder = action ?? args;
  const argv = arrayField(holder, "command").filter((part): part is string => typeof part === "string");
  if (SHELL_COMMAND_FLAG.test(argv[1] ?? "")) return argv.slice(2).join(" ");
  if (argv.length) return argv.join(" ");
  return stringField(holder, "command") ?? stringField(holder, "cmd");
}

function readResponseItem(state: RolloutState, payload: Record<string, unknown>, atMs: number): void {
  const type = stringField(payload, "type") ?? "";
  const callId = stringField(payload, "call_id") ?? stringField(payload, "id");
  if (!callId) return;
  if (TOOL_OUTPUTS.has(type)) {
    const call = state.tools.get(callId);
    if (call && call.endMs === null) call.endMs = atMs;
    return;
  }
  if (!TOOL_CALLS.has(type) || state.tools.has(callId)) return;
  const name = stringField(payload, "name") ?? type;
  state.tools.set(callId, {
    kind: ObservationEventKind.ToolCall,
    atMs,
    source: ObservationSource.Transcript,
    id: callId,
    session: session(state.reading),
    name,
    category: classifyTool(name, commandOf(payload)),
    endMs: null,
    ok: null,
  });
}

function readRow(state: RolloutState, row: Record<string, unknown>): void {
  const stamp = epochMs(row.timestamp);
  const atMs = stamp === null ? 0 : stamp - state.promptAtMs;
  const payload = recordField(row, "payload") ?? {};
  const type = stringField(row, "type");
  if (type === Row.SessionMeta) readMeta(state, payload, stamp);
  if (type === Row.TurnContext) readTurnContext(state, payload);
  if (type === Row.EventMsg && stringField(payload, "type") === TOKEN_COUNT) readTokenCount(state, payload, atMs);
  if (type === Row.ResponseItem) readResponseItem(state, payload, atMs);
  if (type === Row.Compacted) {
    const event: CompactionEvent = {
      kind: ObservationEventKind.Compaction,
      atMs,
      source: ObservationSource.Transcript,
      session: session(state.reading),
    };
    state.reading.compactions.push(event);
  }
}

/** Read one rollout's text; `file` is recorded by basename only. */
export function readRollout(text: string, file: string, promptAtMs: number): RolloutReading {
  const reading: RolloutReading = {
    file: path.basename(file),
    sessionId: null,
    parentSessionId: null,
    cwd: null,
    cliVersion: null,
    startedAtMs: null,
    model: null,
    effort: null,
    finalUsage: null,
    calls: [],
    tools: [],
    compactions: [],
    trace: { parseFailures: 0, partialTail: false, sawTerminal: true },
  };
  const state: RolloutState = { reading, promptAtMs, lastTotal: 0, metaSeen: false, tools: new Map() };
  const rows = text.split("\n");
  rows.forEach((line, index) => {
    if (!line.trim()) return;
    const row = parseObject(line);
    if (row) readRow(state, row);
    else if (index === rows.length - 1) reading.trace.partialTail = true;
    else reading.trace.parseFailures += 1;
  });
  reading.tools = [...state.tools.values()];
  for (const call of reading.calls) call.model ||= reading.model ?? "";
  return reading;
}

async function rolloutFiles(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_SESSION_DEPTH) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await rolloutFiles(full, depth + 1)));
    else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every rollout file under `<codexHome>/sessions`, sorted. A symlink is never followed, and a
 * `sessions` folder that resolves outside the home is not read at all.
 */
export async function listRollouts(codexHome: string): Promise<string[]> {
  const sessions = path.join(codexHome, SESSIONS_DIR);
  const [home, real] = await Promise.all([
    fs.promises.realpath(codexHome).catch(() => null),
    fs.promises.realpath(sessions).catch(() => null),
  ]);
  const stat = await fs.promises.lstat(sessions).catch(() => null);
  if (!home || !real || !stat?.isDirectory() || !isInside(home, real)) return [];
  return rolloutFiles(sessions, 0);
}

/** One rollout read from disk, with the path it was read from (local use only; rows carry basenames). */
export interface RolloutFile {
  path: string;
  rollout: RolloutReading;
}

/** Every rollout in a Codex home, read, with its path. */
export async function readRolloutFiles(codexHome: string, promptAtMs: number): Promise<RolloutFile[]> {
  const files = await listRollouts(codexHome);
  return Promise.all(
    files.map(async (file) => ({
      path: file,
      rollout: readRollout(await fs.promises.readFile(file, "utf8"), file, promptAtMs),
    })),
  );
}

/** Every rollout in a Codex home, read. */
export async function readRollouts(codexHome: string, promptAtMs: number): Promise<RolloutReading[]> {
  return (await readRolloutFiles(codexHome, promptAtMs)).map((file) => file.rollout);
}

/** The main thread's rollout first, then every rollout that chains to it by `parent_thread_id`, breadth first. */
export function chainOf(rollouts: readonly RolloutReading[], threadId: string): RolloutReading[] {
  const main = rollouts.find((rollout) => rollout.sessionId === threadId);
  if (!main) return [];
  const chain = [main];
  const seen = new Set([threadId]);
  for (let at = 0; at < chain.length; at += 1) {
    const parent = chain[at]?.sessionId;
    for (const rollout of rollouts) {
      const child = rollout.sessionId;
      if (!child || seen.has(child) || rollout.parentSessionId !== parent) continue;
      seen.add(child);
      chain.push(rollout);
    }
  }
  return chain;
}

/** A Codex run as its rollouts tell it: the main loop's facts and the chain's events and totals. */
export interface CodexRunReading {
  main: RolloutReading | null;
  chain: RolloutReading[];
  /** The sum of every chained rollout's final `total_token_usage`. */
  total: TokenUsage;
  servedMain: string | null;
  effortServed: string | null;
  cliVersion: string | null;
  /** Model calls and compactions of every thread, and the sub-agents' tool calls (the stream has the main thread's). */
  events: ObservationEvent[];
  trace: TraceReading;
}

/** The run whose main thread is `threadId`, from a Codex home's rollouts. */
export function codexRun(rollouts: readonly RolloutReading[], threadId: string): CodexRunReading {
  const chain = chainOf(rollouts, threadId);
  const main = chain[0] ?? null;
  const events: ObservationEvent[] = [];
  for (const rollout of chain) {
    events.push(...rollout.calls, ...rollout.compactions);
    if (rollout !== main) events.push(...rollout.tools);
  }
  return {
    main,
    chain,
    total: sumUsage(chain.flatMap((rollout) => (rollout.finalUsage ? [rollout.finalUsage] : []))),
    servedMain: main?.model ?? null,
    effortServed: main?.effort ?? null,
    cliVersion: main?.cliVersion ?? null,
    events,
    trace: {
      parseFailures: chain.reduce((sum, rollout) => sum + rollout.trace.parseFailures, 0),
      partialTail: chain.some((rollout) => rollout.trace.partialTail),
      sawTerminal: true,
    },
  };
}
