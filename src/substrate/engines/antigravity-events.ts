/**
 * `agy acp` session updates → the studio's log vocabulary.
 *
 * A turn's `session/update` notifications carry the reply's words a piece at a time
 * (`agent_message_chunk`), the model's thoughts (`agent_thought_chunk`), and each tool call: once
 * when it starts (`tool_call`), then every change of its state (`tool_call_update`: `in_progress`,
 * `pending` while the agent waits for an answer to its permission question, `completed` or
 * `failed`). Antigravity adds the tool's own name and arguments (`name`, `rawInput`) to ACP's
 * `kind` and `title`. The turn's tokens come with the answer to `session/prompt`, which
 * `antigravity.ts` reads. The updates the studio has no use for (the prompt echoed back, the
 * session's title, its commands, its mode and options) translate to nothing.
 *
 * Tools are mirrored as the Claude Code tool each one is, in the compacted shape every consumer
 * reads, as `cursor-events.ts` does for Cursor's. Recorded from Antigravity CLI 1.5.7:
 * `tests/fixtures/transcripts/antigravity-*.jsonl`.
 */
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { AcpToolKind, AcpToolStatus, AcpUpdate } from "./acp.ts";
import { type Json, record, text } from "./antigravity-cli.ts";
import { clip } from "./common.ts";
import type { MirroredEvent } from "./opencode-events.ts";
import { bridgedStudioTool, studioToolName } from "./studio-tool-prompts.ts";
import { DelegateEventType } from "./types.ts";

/** Antigravity's own tools, by the name it gives each, as the chat names the Claude Code tool each one is. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  run_command: "Bash",
  read_file: "Read",
  write_file: "Write",
};

/** A tool Antigravity names nothing the studio knows, by the kind ACP classes it as. */
const KIND_NAMES: Readonly<Record<string, string>> = {
  [AcpToolKind.Read]: "Read",
  [AcpToolKind.Edit]: "Edit",
  [AcpToolKind.Delete]: "Delete",
  [AcpToolKind.Search]: "Grep",
  [AcpToolKind.Execute]: "Bash",
  [AcpToolKind.Fetch]: "WebFetch",
};

/** How much of a tool's input, output and a thought the trace keeps. */
const TRACE_TOOL_INPUT_CHARS = 2_000;
const TRACE_TOOL_RESULT_CHARS = 4_000;
const TRACE_THINKING_CHARS = 4_000;

/** What one update adds to the run. */
export interface AntigravityTranslated {
  events: MirroredEvent[];
  /** A piece of the reply as it streams, for the chat, under the stretch it belongs to. */
  delta?: { streamId: string; text: string };
  /** A stretch of the reply's words that ended: the last one is the build's own summary. */
  text?: string;
  turns?: number;
  /** The session's activity: thinking, or working on a tool call. */
  activity?: ChatActivityPhase;
}

/**
 * What a session's translation remembers between updates: the stretch of the reply that streams
 * and its words so far, the thought being gathered, and the tool calls it has reported starting
 * and ending.
 */
export interface AntigravityStream {
  stretch: number;
  words: string;
  thought: string;
  started: Set<string>;
  ended: Set<string>;
}

/** A translation's memory before the first update. */
export function antigravityStream(): AntigravityStream {
  return { stretch: 0, words: "", thought: "", started: new Set(), ended: new Set() };
}

/** One `session/update`'s `update`, translated; nothing for a kind the studio does not read. */
export function translateAntigravityUpdate(update: Json, stream: AntigravityStream): AntigravityTranslated {
  switch (text(update.sessionUpdate)) {
    case AcpUpdate.AgentMessageChunk:
      return messageChunk(update, stream);
    case AcpUpdate.AgentThoughtChunk:
      stream.thought += text(record(update.content).text);
      return { events: [], activity: ChatActivityPhase.Thinking };
    case AcpUpdate.ToolCall:
    case AcpUpdate.ToolCallUpdate:
      return toolCall(update, stream);
    default:
      return { events: [] };
  }
}

/**
 * The turn ended: the words and the thought still gathered are recorded. `antigravity.ts` calls
 * this once the agent answered `session/prompt`.
 */
export function flushAntigravityStream(stream: AntigravityStream): AntigravityTranslated {
  const thought = takeThought(stream);
  const said = takeWords(stream);
  return { ...said, events: [...thought, ...said.events] };
}

/** A piece of the reply: it streams to the chat and is kept until its stretch ends. */
function messageChunk(update: Json, stream: AntigravityStream): AntigravityTranslated {
  const piece = text(record(update.content).text);
  const events = takeThought(stream);
  if (!piece) return { events };
  stream.words += piece;
  return { events, delta: { streamId: `stretch-${stream.stretch}`, text: piece } };
}

/** The thought gathered so far, as one record, and forgotten. */
function takeThought(stream: AntigravityStream): MirroredEvent[] {
  const thought = stream.thought;
  stream.thought = "";
  if (!thought.trim()) return [];
  return [assistant([{ type: "thinking", text: clip(thought.trim(), TRACE_THINKING_CHARS) }])];
}

/** The stretch of words that just ended, as the record of it; the next words stream under a stretch of their own. */
function takeWords(stream: AntigravityStream): AntigravityTranslated {
  const words = stream.words;
  stream.words = "";
  stream.stretch += 1;
  if (!words.trim()) return { events: [] };
  return { events: [assistant([{ type: "text", text: words }])], text: words, turns: 1 };
}

/**
 * A tool call starting (the chat's working line, once per call however many states it reports)
 * or ending (its result, once); a studio bridge command reads as the studio tool it is.
 */
function toolCall(update: Json, stream: AntigravityStream): AntigravityTranslated {
  const id = text(update.toolCallId);
  const status = text(update.status);
  const over = status === AcpToolStatus.Completed || status === AcpToolStatus.Failed;
  if (!id) return { events: [] };
  const opening = stream.started.has(id) ? null : openCall(update, id, stream);
  const closes = over && !stream.ended.has(id);
  if (!closes) return opening ?? { events: [] };
  stream.ended.add(id);
  const result = ended(update, id, status === AcpToolStatus.Failed);
  return { ...opening, events: [...(opening?.events ?? []), result], activity: ChatActivityPhase.Thinking };
}

/** The first sight of a call: the words and the thought before it are recorded, then the call itself. */
function openCall(update: Json, id: string, stream: AntigravityStream): AntigravityTranslated {
  stream.started.add(id);
  const thought = takeThought(stream);
  const said = takeWords(stream);
  return {
    ...said,
    events: [...thought, ...said.events, started(update, id)],
    turns: (said.turns ?? 0) + 1,
    activity: ChatActivityPhase.Working,
  };
}

/** The call as the chat shows it starting: the tool it is, and what it was asked. */
function started(update: Json, id: string): MirroredEvent {
  const input = record(update.rawInput);
  const command = text(input.CommandLine);
  const bridged = bridgedStudioTool(command);
  const name = bridged ? studioToolName(bridged) : toolName(update);
  const shown = command || shownPath(update, input) || JSON.stringify(input);
  return assistant([{ type: "tool_use", name, id, input: clip(shown, TRACE_TOOL_INPUT_CHARS) }]);
}

/** A tool's name as the chat shows it: the Claude Code tool it is, else its own name, else its title. */
function toolName(update: Json): string {
  const own = text(update.name);
  if (Object.hasOwn(TOOL_NAMES, own)) return TOOL_NAMES[own] ?? own;
  const kind = text(update.kind);
  if (!own && Object.hasOwn(KIND_NAMES, kind)) return KIND_NAMES[kind] ?? kind;
  return own || text(update.title) || "tool";
}

/** The file a call is about: the argument that names it, else the first place ACP says it touches. */
function shownPath(update: Json, input: Json): string {
  const named = text(input.Path) || text(input.path);
  if (named) return named;
  const [first] = Array.isArray(update.locations) ? update.locations : [];
  return text(record(first).path);
}

/**
 * How the call ended: what it printed (a command's output, Antigravity's own header included),
 * else the text or the diff its content carries. A command that exited non-zero failed, whatever
 * its status says.
 */
function ended(update: Json, id: string, failedStatus: boolean): MirroredEvent {
  const output = record(update.rawOutput);
  const exit = output.exit_code;
  const failed = failedStatus || (typeof exit === "number" && exit !== 0);
  const words = text(output.output) || contentText(update.content);
  return user([
    { type: "tool_result", tool_use_id: id, is_error: failed, content: clip(words, TRACE_TOOL_RESULT_CHARS) },
  ]);
}

/** A call's content as words: each text block, and each diff as the file it changed. */
function contentText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .map((block) => {
      const body = record(block);
      if (body.type === "diff") return text(body.path);
      return text(record(body.content).text);
    })
    .filter(Boolean)
    .join("\n");
}

function assistant(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.Assistant, payload: { role: "assistant", parts } };
}

function user(parts: unknown[]): MirroredEvent {
  return { type: DelegateEventType.User, payload: { role: "user", parts } };
}
