/**
 * `cursor-agent --print --output-format stream-json --stream-partial-output` → the studio's log
 * vocabulary.
 *
 * Each line is one event, every one tagged with the session's id: `system` (`init` names the model
 * that runs), `user` (the prompt again), `assistant` (the reply's words: a piece as it streams,
 * then the whole stretch once more before a tool call or at the turn's end), `thinking`
 * (`delta`, `completed`), `tool_call` (`started`, then `completed` with its result), and `result`
 * (the turn's words and tokens). A failed turn writes no event: the CLI says why on stderr and
 * exits non-zero, which `cursor.ts` reads. Cursor's tools are named by their payload's key
 * (`shellToolCall`, `editToolCall`, …) and mirrored as the Claude Code tool each one is, in the
 * compacted shape every consumer reads, as `opencode-events.ts` does for OpenCode's. Built from the
 * CLI's own stream writer (2026.10.22); samples: `tests/fixtures/transcripts/cursor-*.jsonl`.
 */
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { clip } from "./common.ts";
import type { MirroredEvent } from "./opencode-events.ts";
import { studioToolName } from "./studio-tool-prompts.ts";
import { DelegateEventType } from "./types.ts";
import type { Usage } from "../types.ts";

/** Cursor's event types. Its wire spelling: never rename a value. */
export const CursorEvent = {
  System: "system",
  User: "user",
  Assistant: "assistant",
  Thinking: "thinking",
  ToolCall: "tool_call",
  Result: "result",
} as const;
export type CursorEvent = (typeof CursorEvent)[keyof typeof CursorEvent];

/** The subtypes the studio reads. Cursor's wire spelling: never rename a value. */
export const CursorSubtype = {
  Init: "init",
  Started: "started",
  Completed: "completed",
  Delta: "delta",
  Success: "success",
} as const;

/** Cursor's tools by their payload's key, as the chat names the Claude Code tool each one is. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  shellToolCall: "Bash",
  readToolCall: "Read",
  editToolCall: "Edit",
  deleteToolCall: "Delete",
  globToolCall: "Glob",
  grepToolCall: "Grep",
  semSearchToolCall: "Grep",
  lsToolCall: "LS",
  updateTodosToolCall: "TodoWrite",
  readTodosToolCall: "TodoWrite",
  webSearchToolCall: "WebSearch",
  webFetchToolCall: "WebFetch",
  fetchToolCall: "WebFetch",
  taskToolCall: "Task",
  mcpToolCall: "MCP",
};
/** The suffix every tool's key carries (`shellToolCall`). */
const TOOL_KEY_SUFFIX = "ToolCall";

/** How much of a tool's input, output and a thought the trace keeps. */
const TRACE_TOOL_INPUT_CHARS = 2_000;
const TRACE_TOOL_RESULT_CHARS = 4_000;
const TRACE_THINKING_CHARS = 4_000;
/** A bridge call as a command: `node .studio/bridge/tool.mjs <name> …`. */
const STUDIO_BRIDGE_COMMAND = /^node \.studio\/bridge\/tool\.mjs ([\w-]+)/;

/** What one event adds to the run. */
export interface CursorTranslated {
  events: MirroredEvent[];
  /** A piece of the reply as it streams, for the chat, under the stretch it belongs to. */
  delta?: { streamId: string; text: string };
  sessionId?: string;
  /** The model the session reports running, by its display name. */
  model?: string;
  usage?: Partial<Usage>;
  /** The last stretch of the reply's words: the build's own summary. */
  text?: string;
  /** The turn's whole reply as the result gives it, every stretch run together. */
  reply?: string;
  turns?: number;
  /** The session's activity: thinking, or working on a tool call. */
  activity?: ChatActivityPhase;
  /** The turn ended with its result. */
  completed?: boolean;
}

/** What a session's translation remembers between events: which stretch of the reply streams, and its thought. */
export interface CursorStream {
  stretch: number;
  thought: string;
}

/** A translation's memory before the first event. */
export function cursorStream(): CursorStream {
  return { stretch: 0, thought: "" };
}

type Record_ = Record<string, unknown>;

const record = (value: unknown): Record_ =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : {};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const count = (value: unknown): number => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : 0;
};

/** One parsed stream-json line, translated; nothing for a line it does not know. */
export function translateCursorEvent(event: Record_, stream: CursorStream): CursorTranslated {
  const sessionId = text(event.session_id) || undefined;
  const translated = translateBody(event, stream);
  return sessionId ? { ...translated, sessionId } : translated;
}

function translateBody(event: Record_, stream: CursorStream): CursorTranslated {
  switch (text(event.type)) {
    case CursorEvent.System:
      return system(event);
    case CursorEvent.Assistant:
      return assistantWords(event, stream);
    case CursorEvent.Thinking:
      return thinking(event, stream);
    case CursorEvent.ToolCall:
      return toolCall(event);
    case CursorEvent.Result:
      return result(event);
    default:
      return { events: [] };
  }
}

/** The session began: its id is what a resume continues, and its model the one that runs. */
function system(event: Record_): CursorTranslated {
  if (event.subtype !== CursorSubtype.Init) return { events: [] };
  const model = text(event.model) || undefined;
  return {
    events: [
      {
        type: DelegateEventType.System,
        payload: { subtype: CursorSubtype.Init, model, tools: 0, session_id: text(event.session_id) || undefined },
      },
    ],
    ...(model ? { model } : {}),
    activity: ChatActivityPhase.Thinking,
  };
}

/**
 * The reply's words. A piece that streams (a time, no model call) goes to the chat; the whole
 * stretch sent again (before a tool call, or at the turn's end) is the record, and the next words
 * stream under a stretch of their own.
 */
function assistantWords(event: Record_, stream: CursorStream): CursorTranslated {
  const content = record(event.message).content;
  const words = (Array.isArray(content) ? content : []).map((part) => text(record(part).text)).join("");
  const streaming = event.timestamp_ms !== undefined && event.model_call_id === undefined;
  if (streaming)
    return words ? { events: [], delta: { streamId: `stretch-${stream.stretch}`, text: words } } : { events: [] };
  stream.stretch += 1;
  if (!words.trim()) return { events: [] };
  return { events: [assistant([{ type: "text", text: words }])], text: words, turns: 1 };
}

/** A thought, gathered as it streams and recorded once it is complete. */
function thinking(event: Record_, stream: CursorStream): CursorTranslated {
  if (event.subtype === CursorSubtype.Delta) {
    stream.thought += text(event.text);
    return { events: [], activity: ChatActivityPhase.Thinking };
  }
  if (event.subtype !== CursorSubtype.Completed) return { events: [] };
  const thought = stream.thought;
  stream.thought = "";
  if (!thought.trim()) return { events: [] };
  return { events: [assistant([{ type: "thinking", text: clip(thought, TRACE_THINKING_CHARS) }])] };
}

/** A tool call starting (the chat's working line) or ending (its result); a studio bridge command reads as the studio tool it is. */
function toolCall(event: Record_): CursorTranslated {
  const id = text(event.call_id);
  const [key, body] = toolEntry(record(event.tool_call));
  const args = record(body.args);
  const command = text(args.command);
  const bridged = command ? STUDIO_BRIDGE_COMMAND.exec(command)?.[1] : undefined;
  const name = bridged ? studioToolName(bridged) : toolName(key);
  if (event.subtype === CursorSubtype.Started) {
    const shown = command || shownArgs(args);
    return {
      events: [assistant([{ type: "tool_use", name, id, input: clip(shown, TRACE_TOOL_INPUT_CHARS) }])],
      activity: ChatActivityPhase.Working,
      turns: 1,
    };
  }
  if (event.subtype !== CursorSubtype.Completed) return { events: [] };
  const outcome = toolOutcome(record(body.result));
  return {
    events: [
      user([
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: outcome.failed,
          content: clip(outcome.text, TRACE_TOOL_RESULT_CHARS),
        },
      ]),
    ],
    activity: ChatActivityPhase.Thinking,
  };
}

/** The tool's key (`shellToolCall`) and its body; Cursor's tool call is an object of one key. */
function toolEntry(call: Record_): [string, Record_] {
  const key = Object.keys(call).find((name) => name.endsWith(TOOL_KEY_SUFFIX)) ?? "";
  return [key, record(call[key])];
}

/** A tool's name as the chat shows it: the Claude Code tool it is, else its own name without the suffix. */
function toolName(key: string): string {
  if (Object.hasOwn(TOOL_NAMES, key)) return TOOL_NAMES[key] ?? key;
  return key.endsWith(TOOL_KEY_SUFFIX) ? key.slice(0, -TOOL_KEY_SUFFIX.length) : key || "tool";
}

/** What the chat shows a tool was asked: its path or pattern when it has one, else its arguments. */
function shownArgs(args: Record_): string {
  const named = text(args.path) || text(args.pattern) || text(args.globPattern) || text(args.url);
  return named || JSON.stringify(args);
}

/**
 * How a tool ended: its result is an object of one key, `success` or the failure's kind
 * (`failure`, `error`, `rejected`, `fileNotFound`, …). A shell command that failed shows its exit
 * code and what it printed.
 */
function toolOutcome(result: Record_): { failed: boolean; text: string } {
  const [kind] = Object.keys(result);
  if (!kind) return { failed: false, text: "" };
  const body = record(result[kind]);
  const failed = kind !== CursorSubtype.Success;
  const printed = [text(body.stdout), text(body.stderr)].filter(Boolean).join("\n");
  const exit = body.exitCode !== undefined ? `exit ${count(body.exitCode)}` : "";
  const words =
    printed ||
    text(body.content) ||
    text(body.diffString) ||
    text(body.message) ||
    text(body.error) ||
    text(body.reason) ||
    (failed ? kind : "");
  return { failed, text: [failed ? exit : "", words].filter(Boolean).join("\n") };
}

/**
 * The turn ended: its whole reply and its tokens. Cursor's `inputTokens` already leaves out the
 * cache reads and writes it counts apart.
 */
function result(event: Record_): CursorTranslated {
  const usage = record(event.usage);
  const words = text(event.result);
  return {
    events: [],
    completed: true,
    ...(words.trim() ? { reply: words } : {}),
    usage: {
      input_tokens: count(usage.inputTokens),
      output_tokens: count(usage.outputTokens),
      cache_read_tokens: count(usage.cacheReadTokens),
      cache_write_tokens: count(usage.cacheWriteTokens),
    },
  };
}

function assistant(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.Assistant, payload: { role: "assistant", parts } };
}

function user(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.User, payload: { role: "user", parts } };
}
