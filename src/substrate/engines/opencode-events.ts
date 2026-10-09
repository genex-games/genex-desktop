/**
 * `opencode run --format json` → the studio's log vocabulary.
 *
 * Each line is one event: `step_start`, `text`, `reasoning`, `tool_use` (a tool call with its
 * outcome), `step_finish` (that step's tokens and price) and `error`, every one tagged with the
 * session's id. They are mirrored in the compacted Claude Code shape every consumer already reads
 * (the chat rows, the run graph, the morning review), as `codex.ts` mirrors Codex's. Recorded
 * samples: `tests/fixtures/transcripts/opencode-*.jsonl` (OpenCode 1.18).
 */
import { clip } from "./common.ts";
import { DelegateEventType } from "./types.ts";
import { studioToolName } from "./studio-tool-prompts.ts";
import type { Usage } from "../types.ts";

/** OpenCode's event types (`--format json`). Its wire spelling: never rename a value. */
export const OpenCodeEvent = {
  StepStart: "step_start",
  Text: "text",
  Reasoning: "reasoning",
  ToolUse: "tool_use",
  StepFinish: "step_finish",
  Error: "error",
} as const;
export type OpenCodeEvent = (typeof OpenCodeEvent)[keyof typeof OpenCodeEvent];

/** A tool call's state as OpenCode reports it. */
const ToolStatus = { Completed: "completed", Error: "error" } as const;

/** OpenCode's own tool names, as the chat names the Claude Code tool each one is. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  task: "Task",
};

/** How much of a tool's input, output and a thought the trace keeps. */
const TRACE_TOOL_INPUT_CHARS = 2_000;
const TRACE_TOOL_RESULT_CHARS = 4_000;
const TRACE_THINKING_CHARS = 4_000;
/** A bridge call as a command: `node .studio/bridge/tool.mjs <name> …`. */
const STUDIO_BRIDGE_COMMAND = /^node \.studio\/bridge\/tool\.mjs ([\w-]+)/;

/** A contractor message mirrored into the log. */
export interface MirroredEvent {
  type:
    | typeof DelegateEventType.System
    | typeof DelegateEventType.Assistant
    | typeof DelegateEventType.User
    | typeof DelegateEventType.Result;
  payload: unknown;
}

/** What one event adds to the run. */
export interface Translated {
  events: MirroredEvent[];
  sessionId?: string;
  usage?: Partial<Usage>;
  /** The reply's words: the last text is the build's own summary. */
  text?: string;
  /** Set when OpenCode reported the turn failed, with its words and the HTTP status it named. */
  failure?: { message: string; status: number | null };
  turns?: number;
}

type Record_ = Record<string, unknown>;

const record = (value: unknown): Record_ =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : {};

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** One parsed `--format json` line, translated; nothing for a line it does not know. */
export function translateOpenCodeEvent(event: Record_): Translated {
  const sessionId = typeof event.sessionID === "string" && event.sessionID ? event.sessionID : undefined;
  const translated = translateBody(event);
  return sessionId ? { ...translated, sessionId } : translated;
}

function translateBody(event: Record_): Translated {
  const part = record(event.part);
  switch (String(event.type ?? "")) {
    case OpenCodeEvent.Text:
      return text(part);
    case OpenCodeEvent.Reasoning:
      return reasoning(part);
    case OpenCodeEvent.ToolUse:
      return toolUse(part);
    case OpenCodeEvent.StepFinish:
      return stepFinish(part);
    case OpenCodeEvent.Error:
      return error(record(event.error));
    default:
      return { events: [] };
  }
}

function text(part: Record_): Translated {
  const words = String(part.text ?? "");
  if (!words.trim()) return { events: [] };
  return { events: [assistant([{ type: "text", text: words }])], text: words, turns: 1 };
}

function reasoning(part: Record_): Translated {
  const words = String(part.text ?? "");
  if (!words.trim()) return { events: [] };
  return { events: [assistant([{ type: "thinking", text: clip(words, TRACE_THINKING_CHARS) }])] };
}

/** A tool call and its outcome; a studio bridge command reads as the studio tool it is. */
function toolUse(part: Record_): Translated {
  const state = record(part.state);
  const input = record(state.input);
  const tool = String(part.tool ?? "tool");
  const id = String(part.callID ?? part.id ?? "");
  const command = typeof input.command === "string" ? input.command : null;
  const bridged = command ? STUDIO_BRIDGE_COMMAND.exec(command)?.[1] : undefined;
  const name = bridged ? studioToolName(bridged) : (TOOL_NAMES[tool] ?? tool);
  const shown = command ?? JSON.stringify(input);
  const failed = state.status === ToolStatus.Error;
  const finished = failed || state.status === ToolStatus.Completed;
  const output = String((failed ? state.error : state.output) ?? "");
  return {
    events: [
      assistant([{ type: "tool_use", name, id, input: clip(shown, TRACE_TOOL_INPUT_CHARS) }]),
      ...(finished
        ? [
            user([
              {
                type: "tool_result",
                tool_use_id: id,
                is_error: failed,
                content: clip(output, TRACE_TOOL_RESULT_CHARS),
              },
            ]),
          ]
        : []),
    ],
    turns: 1,
  };
}

/**
 * A step's tokens and price. OpenCode's `input` excludes the cache reads it lists apart, and its
 * `output` excludes the reasoning it lists apart; both are kept as the studio counts them.
 */
function stepFinish(part: Record_): Translated {
  const tokens = record(part.tokens);
  const cache = record(tokens.cache);
  return {
    events: [],
    usage: {
      input_tokens: finite(tokens.input),
      output_tokens: finite(tokens.output) + finite(tokens.reasoning),
      reasoning_tokens: finite(tokens.reasoning),
      cache_read_tokens: finite(cache.read),
      cache_write_tokens: finite(cache.write),
      cost_usd: finite(part.cost),
    },
  };
}

/** A failed turn: its words, and the HTTP status the provider answered, when it said one. */
function error(failure: Record_): Translated {
  const data = record(failure.data);
  const message = String(data.message ?? failure.message ?? failure.name ?? "OpenCode stopped") || "OpenCode stopped";
  const status = typeof data.statusCode === "number" && Number.isInteger(data.statusCode) ? data.statusCode : null;
  return {
    events: [{ type: DelegateEventType.Result, payload: { subtype: "error", result: message } }],
    failure: { message, status },
  };
}

function assistant(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.Assistant, payload: { role: "assistant", parts } };
}

function user(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.User, payload: { role: "user", parts } };
}

/** One stdout line as an event, or null for a line that is not one (a stray log line). */
export function parseOpenCodeLine(line: string): Record_ | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : null;
  } catch {
    return null;
  }
}
