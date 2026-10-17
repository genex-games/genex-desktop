/**
 * `pi --mode json` → the studio's log vocabulary.
 *
 * Each line is one JSON object. The first is the session header; the rest are agent events
 * (`json.md` in the Pi coding agent). They are mirrored in the compacted Claude Code shape every
 * consumer already reads. Recorded samples: `tests/fixtures/transcripts/pi-*.jsonl`.
 */
import { clip } from "./common.ts";
import { DelegateEventType } from "./types.ts";
import type { Usage } from "../types.ts";

/** Pi JSON-mode event types. Wire spelling: never rename a value. */
export const PiEvent = {
  Session: "session",
  MessageUpdate: "message_update",
  MessageEnd: "message_end",
  ToolStart: "tool_execution_start",
  ToolEnd: "tool_execution_end",
} as const;
export type PiEvent = (typeof PiEvent)[keyof typeof PiEvent];

const TRACE_TOOL_INPUT_CHARS = 2_000;
const TRACE_TOOL_RESULT_CHARS = 4_000;

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
  text?: string;
  failure?: { message: string; status: number | null };
  turns?: number;
}

type Record_ = Record<string, unknown>;

const record = (value: unknown): Record_ =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : {};

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => (typeof part === "string" ? part : String(record(part).text ?? ""))).join("");
};

/** One parsed `--mode json` line, translated; nothing for a line it does not know. */
export function translatePiEvent(event: Record_): Translated {
  switch (String(event.type ?? "")) {
    case PiEvent.Session:
      return session(event);
    case PiEvent.MessageUpdate:
      return messageUpdate(event);
    case PiEvent.MessageEnd:
      return messageEnd(event);
    case PiEvent.ToolStart:
      return toolStart(event);
    case PiEvent.ToolEnd:
      return toolEnd(event);
    default:
      return { events: [] };
  }
}

function session(event: Record_): Translated {
  const sessionId = typeof event.id === "string" && event.id ? event.id : undefined;
  return sessionId ? { events: [], sessionId } : { events: [] };
}

function messageUpdate(event: Record_): Translated {
  const nested = record(event.assistantMessageEvent);
  const usage = usageOf(record(event.usage));
  if (nested.type === "error") {
    const message = String(nested.error ?? nested.reason ?? "Pi stopped") || "Pi stopped";
    return {
      events: [{ type: DelegateEventType.Result, payload: { subtype: "error", result: message } }],
      failure: { message, status: null },
      usage,
    };
  }
  if (nested.type !== "text_delta") return { events: [], usage };
  const words = String(nested.delta ?? "");
  if (!words) return { events: [], usage };
  return { events: [assistant([{ type: "text", text: words }])], text: words, turns: 1, usage };
}

function messageEnd(event: Record_): Translated {
  const message = record(event.message);
  if (message.role !== "assistant") return { events: [] };
  const words = textOf(message.content).trim();
  if (!words) return { events: [] };
  return { events: [assistant([{ type: "text", text: words }])], text: words, turns: 1 };
}

function toolStart(event: Record_): Translated {
  const name = String(event.toolName ?? "tool");
  const id = String(event.toolCallId ?? "");
  const shown = JSON.stringify(record(event.args));
  return {
    events: [assistant([{ type: "tool_use", name, id, input: clip(shown, TRACE_TOOL_INPUT_CHARS) }])],
    turns: 1,
  };
}

function toolEnd(event: Record_): Translated {
  const id = String(event.toolCallId ?? "");
  const failed = event.isError === true;
  const output = textOf(record(event.result).content);
  return {
    events: [
      user([
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: failed,
          content: clip(output, TRACE_TOOL_RESULT_CHARS),
        },
      ]),
    ],
  };
}

function usageOf(usage: Record_): Partial<Usage> | undefined {
  const input = finite(usage.input);
  const output = finite(usage.output);
  const cacheRead = finite(usage.cacheRead);
  const cacheWrite = finite(usage.cacheWrite);
  const cost = finite(record(usage.cost).total);
  if (!input && !output && !cacheRead && !cacheWrite && !cost) return undefined;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cost_usd: cost,
  };
}

function assistant(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.Assistant, payload: { role: "assistant", parts } };
}

function user(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.User, payload: { role: "user", parts } };
}

/** One stdout line as an event, or null for a line that is not one (a stray log line). */
export function parsePiLine(line: string): Record_ | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : null;
  } catch {
    return null;
  }
}
