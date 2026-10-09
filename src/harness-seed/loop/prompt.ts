/**
 * Prompt materialisation — PLAN.md §5.1, §5.4.
 *
 * The prompt is a *projection of the event log*, rebuilt from scratch every round. Nothing about
 * the conversation lives in memory, so the studio can be killed at any instant and resume with
 * exactly the same mind. What the system prompt stands on — identity, rules, skills, memory, the
 * game's notes and file list — is read once per turn (`readStanding`): a local model re-reads
 * everything after the first changed token, so a fact remembered or a file written mid-turn made
 * the next round re-read the whole turn. The next turn reads them afresh.
 *
 * Three things the plan leaves to implementation, decided here:
 *  - **Skills are injected by name + description every turn, bodies on demand** (Exo's
 *    `skill-tools` semantics). Bodies are large and the point of a skill index is that the model
 *    asks for what it needs.
 *  - **A window measured in tokens, not messages.** Local models have small, *known* context
 *    limits; sixty short messages are nothing and sixty tool dumps are an overflow. When the
 *    caller knows the model's context window, the tail is trimmed to fit a fixed share of it and
 *    oversized tool results are clamped. The log remains complete on disk, and every elision is
 *    stated in the prompt rather than silent.
 *  - **A `compacted` event replaces everything before it.** Compaction appends a summary to the
 *    log (see compact.ts) — the log keeps every original message; the prompt starts from the
 *    summary.
 */
import { loadSkills, formatSkillIndex, type Skill } from "./skills.ts";
import type { AnyRecord, HarnessCtx, HarnessEvent } from "../types/harness.d.ts";
import type { Message } from "../types/host-api.d.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind, RunEvent } from "./run-events.ts";

/** What the system prompt stands on besides the tools and the turn's briefing: read once per turn. */
export interface StandingContext {
  skills: Skill[];
  identity: string;
  rules: string;
  memory: AnyRecord;
  notes: string | null;
  inventory: string | null;
}

/** What a prompt is built from: the thread, the tools of this round, and the turn's own options. */
export interface PromptOptions {
  threadId: string;
  tools?: { summary(): string } | null;
  /** The turn's standing context; read here when the caller has none. */
  standing?: StandingContext;
  project?: string | null;
  projectDir?: string;
  extraReads?: unknown;
  extraSystem?: string;
  preserveHistory?: boolean;
  contextWindow?: number | null;
  window?: number;
  [option: string]: unknown;
}

/** A prompt as one round sends it, with what each part cost. */
export interface MaterializedPrompt {
  systemPrompt: string;
  messages: Message[];
  skills: Skill[];
  /** What the system prompt stood on: handed to the turn's next round, it starts from the same prefix. */
  standing: StandingContext;
  tokens: { system: number; conversation: number; full: number; budget: number | null; contextWindow: number | null };
}

const DEFAULT_WINDOW = 60;
/** Share of the model's context the conversation may use — the rest is system prompt + reply. */
export const CONTEXT_SHARE = 0.7;
/** A single message larger than this (tokens) gets its middle clamped in the prompt. */
const CLAMP_MESSAGE_TOKENS = 2_000;
/**
 * The share of the context window one tool result may take in a preserved history. Compaction
 * keeps the recent tail whole, so a single result larger than the window used to fail every later
 * turn with "context cannot fit"; the log keeps the whole result.
 */
const TOOL_RESULT_WINDOW_SHARE = 0.25;
/** How much of a game's NOTES.md a prompt carries. */
const GAME_NOTES_CHARS = 6_000;
/** How many of the folder's files a prompt lists by name. */
const LISTED_FILES = 80;

/** Rough but stable: ~4 characters per token. Exact counts come back from the engine per turn. */
export function estimateTokens(text: string | null | undefined): number {
  return Math.ceil((text ?? "").length / 4);
}

export function estimateMessagesTokens(messages: readonly Pick<Message, "content">[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.content) + 8;
  return total;
}

/** Identity, rules, skills, memory and the game's notes and files, as this turn starts. */
export async function readStanding(
  ctx: HarnessCtx,
  options: Pick<PromptOptions, "project" | "projectDir" | "extraReads">,
): Promise<StandingContext> {
  const skills = await loadSkills(ctx.workspace);
  const identity = await readPromptFile(ctx, "prompts/identity.md");
  const rules = await readPromptFile(ctx, "prompts/operating-rules.md");
  const memory = (await ctx.call(HostMethod.ArtifactRead, { artifactId: "memory" }).catch(() => null)) ?? {};
  const notes = options.project ? await readGameNotes(ctx, options.project) : null;
  const inventory = options.project ? await readProjectInventory(ctx, options.project, options) : null;
  return { skills, identity, rules, memory, notes, inventory };
}

export async function materializePrompt(ctx: HarnessCtx, options: PromptOptions): Promise<MaterializedPrompt> {
  const { threadId, tools } = options;
  const events = await ctx.call(HostMethod.EventsList, { threadId });
  const messages = eventsToMessages(events);
  const standing = options.standing ?? (await readStanding(ctx, options));
  const { skills, identity, rules, memory, notes, inventory } = standing;
  const toolNotes = tools?.summary() ?? "";

  const systemPrompt = [
    identity,
    rules,
    formatSkillIndex(skills),
    formatMemory(memory),
    notes ? `## Notes for the game "${options.project}" (NOTES.md — keep it current)\n${notes}` : "",
    inventory ?? "",
    toolNotes ? `## About your tools\n${toolNotes}` : "",
    options.extraSystem ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const systemTokens = estimateTokens(systemPrompt);
  let windowed: Message[];
  let budget: number | null = null;
  if (options.preserveHistory) {
    // The caller enforces compaction before inference. Do not silently discard history
    // using a second, lower threshold after the user selected a larger working budget.
    windowed = clampToolResults(messages, options.contextWindow);
  } else if (options.contextWindow) {
    budget = Math.max(1_500, Math.floor(options.contextWindow * CONTEXT_SHARE) - systemTokens);
    windowed = windowMessagesToBudget(messages, budget);
  } else {
    windowed = windowMessages(messages, options.window ?? DEFAULT_WINDOW);
  }

  return {
    systemPrompt,
    messages: windowed,
    skills,
    standing,
    tokens: {
      system: systemTokens,
      conversation: estimateMessagesTokens(windowed),
      full: estimateMessagesTokens(messages),
      budget,
      contextWindow: options.contextWindow ?? null,
    },
  };
}

/** The studio's living memory of a game, written by whoever built it last. */
async function readGameNotes(ctx: HarnessCtx, project: string): Promise<string | null> {
  try {
    const text = await ctx.call(HostMethod.GameRead, { project, file: "NOTES.md" });
    const body = typeof text === "string" ? text : ((text as { text?: string } | null)?.text ?? "");
    const trimmed = body.trim();
    return trimmed.length > 0 ? trimmed.slice(0, GAME_NOTES_CHARS) : null;
  } catch {
    return null;
  }
}

/** What is actually in the folder — including stills the user dropped for you to look at. */
async function readProjectInventory(
  ctx: HarnessCtx,
  project: string,
  options: { projectDir?: string; extraReads?: unknown } = {},
): Promise<string | null> {
  try {
    const files = await ctx.call(HostMethod.GameTree, { project });
    const list = Array.isArray(files) ? files : [];
    const image = /\.(png|jpe?g|webp|gif)$/i;
    const lines = list
      .slice(0, LISTED_FILES)
      .map((file) => (image.test(file) ? `- ${file} (image — read_file shows you the picture)` : `- ${file}`));
    const more = list.length > LISTED_FILES ? `\n- …and ${list.length - LISTED_FILES} more` : "";
    const dir = options.projectDir ?? "";
    const extra = Array.isArray(options.extraReads) ? options.extraReads : [];
    const extraLines = extra.map(
      (folder) => `- ${folder} (the user named this — read_file the stills here, do not copy them)`,
    );
    return [
      `## This project's folder`,
      dir
        ? `You are working in \`${dir}\`. Relative paths resolve here. Do not \`cd\` elsewhere. Do not create another copy of this game. Do not search the rest of the disk for folders named \`references\`.`
        : `These files live in the folder the user opened.`,
      extra.length
        ? `The user named stills outside this folder. Look at them with \`read_file\` using those absolute paths. Do not copy them into this project.\n${extraLines.join("\n")}`
        : `Stills may be in \`references/\`, \`ref/\`, or a path the user named. Look at them with \`read_file\`. Do not load them as textures.`,
      lines.length ? lines.join("\n") + more : "- (empty folder)",
    ].join("\n");
  } catch {
    return null;
  }
}

/**
 * Rebuild the conversation from log events. Tool results become `tool` messages bound to the
 * assistant's call ids, so the model sees the exact shape it produced.
 */
export function eventsToMessages(events: readonly HarnessEvent[]): Message[] {
  return eventsToMessagesWithSources(events).messages;
}

/**
 * Same, but each message remembers the id of the event it came from (`sources[i]`), which is
 * what lets a `compacted` event replace exactly the messages it summarised and no more.
 */
export function eventsToMessagesWithSources(events: readonly HarnessEvent[]): {
  messages: Message[];
  sources: string[];
} {
  const log: MessageLog = { messages: [], sources: [], toolNames: new Map() };
  for (const event of events) absorbEvent(log, event);
  answerCallsNeverRun(log);
  return { messages: log.messages, sources: log.sources };
}

/**
 * A call the turn stopped before running (Stop, a crash) has no result in the log. Engines refuse
 * or misread an assistant call left unanswered, so each gets a failed result saying it did not
 * run, placed after the results its round did get.
 */
function answerCallsNeverRun(log: MessageLog): void {
  const answered = new Set(log.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (let i = log.messages.length - 1; i >= 0; i--) {
    const message = log.messages[i];
    if (message?.role !== "assistant") continue;
    const unanswered = (message.tool_calls ?? []).filter((call) => !answered.has(call.id));
    if (unanswered.length === 0) continue;
    let at = i + 1;
    while (log.messages[at]?.role === "tool") at++;
    const notRun = unanswered.map((call) => ({
      role: "tool" as const,
      content: CALL_NOT_RUN,
      tool_call_id: call.id,
      name: call.name,
      is_error: true,
    }));
    log.messages.splice(at, 0, ...notRun);
    const source = log.sources[i] ?? "";
    log.sources.splice(at, 0, ...notRun.map(() => source));
  }
}

/** The conversation as it is rebuilt: each message, the event it came from, and the tools called so far. */
interface MessageLog {
  messages: Message[];
  sources: string[];
  toolNames: Map<string, string>;
}

/** Add `message`, remembering the event it came from. */
function record(log: MessageLog, eventId: string, message: Message): void {
  log.messages.push(message);
  log.sources.push(eventId);
}

/** Fold one log event into the conversation. */
function absorbEvent(log: MessageLog, event: HarnessEvent): void {
  const data = event.data;
  if (data.type === EventKind.Messages) {
    for (const message of data.messages) record(log, event.id, message);
    return;
  }
  if (data.type === EventKind.ToolRequested) {
    log.toolNames.set(data.tool_call_id, data.request?.name ?? "tool");
    return;
  }
  if (data.type === EventKind.Custom && data.event_type === RunEvent.Compacted) {
    replaceCompacted(log.messages, log.sources, event.id, data.payload ?? {});
    return;
  }
  const message = data.type === EventKind.ToolResult ? toolResultMessage(data, log.toolNames) : noteOf(data);
  if (message) record(log, event.id, message);
}

/** A tool's result, bound to the call id (and tool name) the assistant produced. */
function toolResultMessage(data: AnyRecord, toolNames: ReadonlyMap<string, string>): Message {
  return {
    role: "tool",
    content: data.result?.content ?? "",
    tool_call_id: data.tool_call_id,
    name: toolNames.get(data.tool_call_id) ?? "tool",
    ...(data.result?.ok === false ? { is_error: true } : {}),
  };
}

/** The result a call the turn never ran reads as. */
const CALL_NOT_RUN = "[not run — the turn stopped before this tool call ran; nothing it would have done happened]";

/** What the substrate says in the conversation about an event: a restore, a self-restart, an error. */
function noteOf(data: AnyRecord): Message | null {
  if (data.type === EventKind.WorkspaceRestored) {
    return {
      role: "system",
      content: `[substrate] workspace restored from snapshot ${data.snapshot_id} (${data.reason}).`,
    };
  }
  if (data.type === EventKind.Custom && data.event_type === RunEvent.RebuildAndRestartStudio) {
    const payload = data.payload ?? {};
    const health = payload.ok ? "the new version is healthy" : "the new version FAILED its healthcheck";
    return {
      role: "system",
      content: `[substrate] you restarted yourself (${payload.reason ?? "no reason given"}) — ${health}.`,
    };
  }
  if (data.type === EventKind.Error) return { role: "system", content: `[error] ${data.message}` };
  return null;
}

/**
 * The summary replaces the messages it covered (events up to `upTo`); everything after —
 * the kept tail — stays verbatim. Without `upTo`, it covers all messages so far. A compaction
 * with no summary replaces nothing: Codex's own keeps its summary sealed inside its session, and a
 * prompt built from the log still needs the messages.
 *
 * Covered is by position: through the last message whose event is not newer than `upTo`. The
 * sources are not in id order after a compaction — the earlier summary leads, newer than the
 * tail it kept — so a scan that stopped at the first newer id replaced nothing when a second
 * compaction's cut fell inside that tail, and the prompt never shrank.
 */
function replaceCompacted(messages: Message[], sources: string[], eventId: string, payload: AnyRecord): void {
  if (!String(payload.summary ?? "").trim()) return;
  const covered = payload.upTo ? sources.findLastIndex((source) => source <= payload.upTo) + 1 : messages.length;
  messages.splice(0, covered);
  sources.splice(0, covered);
  messages.unshift({
    role: "system",
    content:
      `[the conversation so far was compacted — ${payload.messages ?? "the earlier"} messages ` +
      `were summarised; the originals remain in the log]\n${payload.summary ?? ""}`,
  });
  sources.unshift(eventId);
}

/** Keep the opening intent and the recent tail; say out loud what was dropped. */
export function windowMessages(messages: Message[], limit: number): Message[] {
  if (messages.length <= limit) return messages;
  const head = messages.slice(0, 2);
  const tailLength = Math.max(1, limit - head.length - 1);
  const tail = messages.slice(-tailLength);
  const dropped = messages.length - head.length - tail.length;
  return [
    ...head,
    {
      role: "system",
      content: `[${dropped} earlier messages elided from this prompt — the full log is on disk; use the log tools to read any part of it]`,
    },
    ...tail,
  ];
}

/**
 * Token-budget window: opening intent + the largest recent tail that fits. Oversized single
 * messages (usually tool dumps) are clamped in the middle so one giant result cannot evict the
 * whole conversation.
 */
export function windowMessagesToBudget(messages: Message[], budgetTokens: number): Message[] {
  const clamped = messages.map((message) => clampMessage(message));
  if (estimateMessagesTokens(clamped) <= budgetTokens) return clamped;

  const head = clamped.slice(0, 2);
  const headTokens = estimateMessagesTokens(head) + 40; // elision marker allowance
  const tail: Message[] = [];
  let tailTokens = 0;
  for (let i = clamped.length - 1; i >= head.length; i--) {
    const cost = estimateTokens(clamped[i].content) + 8;
    if (headTokens + tailTokens + cost > budgetTokens && tail.length > 0) break;
    tail.unshift(clamped[i]);
    tailTokens += cost;
    if (headTokens + tailTokens > budgetTokens) break; // at least one tail message, even oversized
  }
  // Never open the tail with a tool result whose call was trimmed away — backends reject
  // orphaned tool messages.
  while (tail.length > 1 && tail[0].role === "tool") tail.shift();
  const dropped = clamped.length - head.length - tail.length;
  if (dropped <= 0) return clamped;
  return [
    ...head,
    {
      role: "system",
      content: `[${dropped} earlier messages elided to fit the model's context — the full log is on disk; use the log tools to read any part of it]`,
    },
    ...tail,
  ];
}

/** A preserved history with no tool result over its share of the window, or compaction cannot help. */
function clampToolResults(messages: Message[], contextWindow: number | null | undefined): Message[] {
  if (!contextWindow) return messages;
  const cap = Math.floor(contextWindow * TOOL_RESULT_WINDOW_SHARE);
  return messages.map((m) => (m.role === "tool" ? clampMessage(m, cap) : m));
}

function clampMessage(message: Message, maxTokens = CLAMP_MESSAGE_TOKENS): Message {
  const tokens = estimateTokens(message.content);
  if (tokens <= maxTokens) return message;
  const keep = maxTokens * 4;
  const headText = message.content.slice(0, Math.floor(keep * 0.7));
  const tailText = message.content.slice(-Math.floor(keep * 0.3));
  const cut = message.content.length - headText.length - tailText.length;
  return {
    ...message,
    content: `${headText}\n…[${cut} characters clamped from this message to fit the context — full text in the log]…\n${tailText}`,
  };
}

function formatMemory(memory: unknown): string {
  const entries = Object.entries((memory ?? {}) as Record<string, unknown>);
  if (entries.length === 0) return "";
  const lines = entries.map(
    ([key, value]) => `- **${key}**: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  return `## What you remember\n${lines.join("\n")}`;
}

async function readPromptFile(ctx: HarnessCtx, relative: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  try {
    return await readFile(path.join(ctx.workspace, relative), "utf8");
  } catch {
    return "";
  }
}
