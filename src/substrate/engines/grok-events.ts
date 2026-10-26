/**
 * `grok -p --output-format streaming-json` → the studio's log vocabulary.
 *
 * Each line is one event, Grok Build's own ACP session update: `thought` and `text` chunks,
 * `tool_call` as a call starts and `tool_call_update` as it runs and ends, `usage` at the end of
 * each model response, then `end` (the session, the turn's tokens) or `error`. They are mirrored
 * in the compacted Claude Code shape every consumer already reads (the chat rows, the run graph,
 * the morning review), as `opencode-events.ts` mirrors OpenCode's. A reply's chunks stream to the
 * chat as they arrive and become one row when the response ends. A call is mirrored as it starts
 * and its result as it ends, so a steer cuts the session between calls by their ids
 * (`main/core/steer-cut.ts`). Recorded samples: `tests/fixtures/transcripts/grok-*` (Grok Build 1.0.70).
 */
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { clip } from "./common.ts";
import { DelegateEventType } from "./types.ts";
import { studioToolName } from "./studio-tool-prompts.ts";
import type { Usage } from "../types.ts";
import { stripTerminalCodes } from "../../shared/terminal.ts";

/** Grok Build's event types (`streaming-json`). Its wire spelling: never rename a value. */
export const GrokEvent = {
  Thought: "thought",
  Text: "text",
  ToolCall: "tool_call",
  ToolCallUpdate: "tool_call_update",
  Usage: "usage",
  End: "end",
  Error: "error",
  CompactCompleted: "auto_compact_completed",
} as const;
export type GrokEvent = (typeof GrokEvent)[keyof typeof GrokEvent];

/** A tool call's state as ACP reports it; only the last two end it. */
const ToolStatus = { Completed: "completed", Failed: "failed" } as const;

/** Grok Build's own tool names, as the chat names the Claude Code tool each one is. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  run_terminal_command: "Bash",
  run_terminal_cmd: "Bash",
  read_file: "Read",
  search_replace: "Edit",
  write: "Write",
  list_dir: "LS",
  grep: "Grep",
  todo_write: "TodoWrite",
  spawn_subagent: "Task",
  web_search: "WebSearch",
};

/** How much of a tool's input, output and a thought the trace keeps. */
const TRACE_TOOL_INPUT_CHARS = 2_000;
const TRACE_TOOL_RESULT_CHARS = 4_000;
const TRACE_THINKING_CHARS = 4_000;
/** A bridge call as a command: `node .studio/bridge/tool.mjs <name> …`. */
const STUDIO_BRIDGE_COMMAND = /^node \.studio\/bridge\/tool\.mjs ([\w-]+)/;
/** What a picture in a tool's result reads as in the trace. */
const IMAGE_PLACEHOLDER = "[image]";
/** An error line of the CLI's log (`RUST_LOG=error`) and the HTTP status field it carries. */
const LOG_ERROR_LINE = /\bERROR\b/;
const LOG_STATUS_FIELD = /\bstatus=(\d{3})\b/;

/** A contractor message mirrored into the log, or a chunk of the reply streamed to the chat. */
export interface GrokMirrored {
  type:
    | typeof DelegateEventType.Assistant
    | typeof DelegateEventType.User
    | typeof DelegateEventType.Result
    | typeof DelegateEventType.TextDelta;
  payload: unknown;
}

/** What one event adds to the run. */
export interface Translated {
  events: GrokMirrored[];
  sessionId?: string;
  /** One model response's tokens, for a run cut short before its end. */
  usage?: Partial<Usage>;
  /** The whole turn's tokens as the CLI counted them at its end: they replace the responses' sum. */
  totals?: Partial<Usage>;
  /** A response's whole prompt, cached or not: how full the session's context is now. */
  promptTokens?: number;
  /** The reply's words: the last text is the build's own summary. */
  text?: string;
  /** Set when Grok reported the turn failed, with its words and the HTTP status it named. */
  failure?: { message: string; status: number | null };
  turns?: number;
  /** The session compacted itself (Compact Now, or Grok's own as it filled). */
  compacted?: boolean;
  activity?: ChatActivityPhase;
}

/** One stream's translator: chunks are gathered until their response ends. */
export interface GrokStream {
  translate(event: Record_): Translated;
  /** Whatever was still gathering when the stream ended. */
  flush(): Translated;
}

type Record_ = Record<string, unknown>;

const record = (value: unknown): Record_ =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : {};

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const NOTHING: Translated = { events: [] };

/** A new translator for one `grok -p` run. */
export function grokStream(): GrokStream {
  let thinking = "";
  let replying = "";
  let replies = 0;

  /** A response's thought and reply so far, as rows; the reply is also the summary. */
  const gathered = (): Translated => {
    const events: GrokMirrored[] = [];
    if (thinking.trim()) events.push(assistant([{ type: "thinking", text: clip(thinking, TRACE_THINKING_CHARS) }]));
    const text = replying.trim() ? replying : "";
    if (text) events.push(assistant([{ type: "text", text }]));
    thinking = "";
    replying = "";
    return text ? { events, text } : { events };
  };

  /** What came before a boundary, then what the boundary itself says. */
  const after = (translated: Translated): Translated => {
    const before = gathered();
    return {
      ...translated,
      ...(before.text ? { text: before.text } : {}),
      events: [...before.events, ...translated.events],
    };
  };

  const translateBody = (event: Record_): Translated => {
    switch (String(event.type ?? "")) {
      case GrokEvent.Thought: {
        // A thought after the reply began belongs to the next row.
        const before = replying ? gathered() : NOTHING;
        thinking += String(event.data ?? "");
        return { ...before, activity: ChatActivityPhase.Thinking };
      }
      case GrokEvent.Text: {
        const delta = String(event.data ?? "");
        if (!delta) return NOTHING;
        if (!replying) replies++;
        replying += delta;
        return {
          events: [{ type: DelegateEventType.TextDelta, payload: { streamId: `grok-reply-${replies}`, delta } }],
          activity: ChatActivityPhase.Responding,
        };
      }
      case GrokEvent.ToolCall:
        return after(toolCall(event));
      case GrokEvent.ToolCallUpdate:
        return toolResult(event);
      case GrokEvent.Usage:
        return after(responseUsage(record(event.usage)));
      case GrokEvent.End:
        return after(end(event));
      case GrokEvent.Error:
        return after(error(event));
      case GrokEvent.CompactCompleted:
        return { events: [], compacted: true };
      default:
        return NOTHING;
    }
  };

  return {
    translate(event) {
      const translated = translateBody(event);
      const sessionId = typeof event.sessionId === "string" && event.sessionId ? event.sessionId : undefined;
      return sessionId ? { ...translated, sessionId } : translated;
    },
    flush: gathered,
  };
}

/** A call starting: mirrored now, so the chat shows it running and a steer waits for its end. */
function toolCall(event: Record_): Translated {
  const input = record(event.rawInput);
  const tool = String(event.toolName ?? event.title ?? "tool");
  const id = String(event.toolCallId ?? "");
  const command = typeof input.command === "string" ? input.command : null;
  const bridged = command ? STUDIO_BRIDGE_COMMAND.exec(command)?.[1] : undefined;
  const name = bridged ? studioToolName(bridged) : (TOOL_NAMES[tool] ?? tool);
  const shown = command ?? JSON.stringify(input);
  return {
    events: [assistant([{ type: "tool_use", name, id, input: clip(shown, TRACE_TOOL_INPUT_CHARS) }])],
    activity: ChatActivityPhase.Tool,
  };
}

/** A call's progress: nothing until it ends, then its result. */
function toolResult(event: Record_): Translated {
  const status = event.status;
  if (status !== ToolStatus.Completed && status !== ToolStatus.Failed) return NOTHING;
  const id = String(event.toolCallId ?? "");
  const output = resultText(event);
  return {
    events: [
      user([
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: status === ToolStatus.Failed,
          content: clip(output, TRACE_TOOL_RESULT_CHARS),
        },
      ]),
    ],
    activity: ChatActivityPhase.Thinking,
  };
}

/** A result's words: its content blocks (a picture as a placeholder), else what its raw output says. */
function resultText(event: Record_): string {
  const blocks = Array.isArray(event.content) ? event.content : [];
  const words = blocks
    .map((block) => record(record(block).content))
    .map((content) => (content.type === "image" ? IMAGE_PLACEHOLDER : String(content.text ?? "")))
    .join("");
  return words || rawOutputText(record(event.rawOutput));
}

/**
 * The words a tool's raw output carries when its content has none: a command's output, or the one
 * object a tool reports under its own kind (a listing's `content`, an edit's `tool_output_for_prompt`).
 */
function rawOutputText(raw: Record_): string {
  if (typeof raw.output_for_prompt === "string") return raw.output_for_prompt;
  for (const value of Object.values(raw)) {
    const reported = record(value);
    const words = reported.tool_output_for_prompt ?? reported.content;
    if (typeof words === "string") return words;
  }
  return "";
}

/** Grok's token buckets in the studio's names: input is uncached, reasoning is inside output. */
function tokens(usage: Record_): Partial<Usage> {
  return {
    input_tokens: finite(usage.input_tokens),
    output_tokens: finite(usage.output_tokens),
    cache_read_tokens: finite(usage.cache_read_input_tokens),
    cache_write_tokens: finite(usage.cache_creation_input_tokens),
    reasoning_tokens: finite(usage.reasoning_tokens),
  };
}

/** One model response ended: its tokens, and the prompt it filled. */
function responseUsage(usage: Record_): Translated {
  const counted = tokens(usage);
  const promptTokens =
    (counted.input_tokens ?? 0) + (counted.cache_read_tokens ?? 0) + (counted.cache_write_tokens ?? 0);
  return { events: [], usage: counted, promptTokens, turns: 1 };
}

/** The turn ended: its session, and its tokens and price as the CLI totalled them. */
function end(event: Record_): Translated {
  const usage = event.usage === undefined ? null : record(event.usage);
  const cost = event.total_cost_usd;
  const totals = usage
    ? { ...tokens(usage), ...(typeof cost === "number" && Number.isFinite(cost) ? { cost_usd: cost } : {}) }
    : undefined;
  const turns = typeof event.num_turns === "number" ? event.num_turns : undefined;
  return {
    events: [],
    ...(totals ? { totals } : {}),
    ...(turns !== undefined ? { turns } : {}),
    activity: ChatActivityPhase.Completed,
  };
}

/**
 * A failed turn: its words, and the HTTP status xAI answered when the error carries one (an
 * `http_status` field in the JSON body the CLI quotes).
 */
function error(event: Record_): Translated {
  const raw = String(event.message ?? "") || "Grok Build stopped";
  const body = quotedBody(raw);
  const message = typeof body?.message === "string" && body.message ? body.message : raw;
  const status = typeof body?.http_status === "number" && Number.isInteger(body.http_status) ? body.http_status : null;
  return {
    events: [{ type: DelegateEventType.Result, payload: { subtype: "error", result: message } }],
    failure: { message, status },
  };
}

/** The JSON object an error message quotes after its first words, or null when it quotes none. */
function quotedBody(message: string): Record_ | null {
  const start = message.indexOf("{");
  if (start < 0) return null;
  try {
    const value = JSON.parse(message.slice(start)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : null;
  } catch {
    return null;
  }
}

/**
 * The HTTP status of the last API error the CLI logged (`RUST_LOG=error` puts it on stderr as a
 * `status=` field): Grok's own error event leaves it out once its retries for a 429 ran out. Some
 * versions colour the log whatever `NO_COLOR` says, so the colours come off first.
 */
export function grokStderrStatus(stderr: string): number | null {
  let status: number | null = null;
  for (const line of stripTerminalCodes(stderr).split("\n")) {
    if (!LOG_ERROR_LINE.test(line)) continue;
    const field = LOG_STATUS_FIELD.exec(line);
    if (field) status = Number(field[1]);
  }
  return status;
}

function assistant(parts: unknown[]): GrokMirrored {
  return { type: DelegateEventType.Assistant, payload: { role: "assistant", parts } };
}

function user(parts: unknown[]): GrokMirrored {
  return { type: DelegateEventType.User, payload: { role: "user", parts } };
}

/** One stdout line as an event, or null for a line that is not one (a warning, a stray log line). */
export function parseGrokLine(line: string): Record_ | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : null;
  } catch {
    return null;
  }
}
