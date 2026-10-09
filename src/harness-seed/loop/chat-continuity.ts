/**
 * One conversation, whichever model answers it: the person may switch the chat's model at any
 * message. A session goes on only while it is the chat's latest (`goesOn`): one
 * that another model answered after has missed those turns. A fresh session whose brief cannot
 * carry the conversation is briefed with a written summary (`briefSummary`), which a Codex
 * compaction cannot give: Codex keeps its own sealed inside its session.
 */
import { TRANSCRIPT_CHARS, TRANSCRIPT_MESSAGES } from "./brief-window.ts";
import { compactThread } from "./compact.ts";
import { compactedSummary } from "./compaction-log.ts";
import { HostMethod } from "./host-methods.ts";
import { eventsToMessagesWithSources } from "./prompt.ts";
import { resolveContextWindow } from "./tool-loop.ts";
import type { HarnessCtx, HarnessEvent } from "../types/harness.d.ts";

/** The chat's latest session, when it is this engine's: only that one goes on. */
export function goesOn<T extends { engine?: string }>(latest: T | null, engine: string): T | null {
  return latest?.engine === engine ? latest : null;
}

/** Whether a fresh session's brief quotes everything since the chat's last written summary. */
export function briefCarries(events: readonly HarnessEvent[]): boolean {
  const said = eventsToMessagesWithSources([...events]).messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  const quoted = said.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n");
  return said.length <= TRANSCRIPT_MESSAGES && quoted.length <= TRANSCRIPT_CHARS;
}

/**
 * The summary a fresh session is briefed with. When its brief cannot carry the conversation, the
 * log is summarised first, on this engine (loop/compact.ts), as Compact now does where no session
 * can; a summary that could not be written leaves the brief as it was.
 */
export async function briefSummary(
  ctx: HarnessCtx,
  { threadId, engine, model, events }: { threadId: string; engine: string; model?: string; events: HarnessEvent[] },
): Promise<string | null> {
  if (briefCarries(events)) return compactedSummary(events);
  const described = await ctx.call(HostMethod.EngineDescribe, {}).catch(() => []);
  const contextWindow = resolveContextWindow(described, engine, model);
  const report = await compactThread(ctx, { threadId, engine, model, contextWindow, force: true }).catch(() => null);
  if (!report?.compacted) return compactedSummary(events);
  return compactedSummary(await ctx.call(HostMethod.EventsList, { threadId }));
}
