/**
 * What a finish check reads of its run's log besides its inbox: which of the run's messages are the
 * person's own words and which the chat's agent relayed (`steer_run`, `resume_run`, a reopen's ask
 * are its words, not the person's), and the newest round of the run's checks so far, so a round's
 * number never repeats whatever the journal that kept the count. A log that cannot be read says
 * every message was relayed and no round was recorded. A module of its own, so the shipped parts that
 * read the inbox need no new name.
 */
import type { HarnessCtx, HarnessEvent } from "../types/harness.d.ts";
import { FINISH_CHECK_EVENT } from "./finish-contract.ts";
import { HostMethod } from "./host-methods.ts";
import { messageQueueState } from "./message-queue.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { SteerDelivery } from "./steer-delivery.ts";

/** The run's messages, split by whose words they are, and the newest round recorded. */
export interface FinishLog {
  /** The person's own words, oldest first. */
  said: string[];
  /** The rest: relayed by the chat's agent, in its words, oldest first. */
  relayed: string[];
  /** The newest round of the run's finish checks in the log; 0 without one. */
  lastRound: number;
}

/** A custom record's payload with its event name, or null for any other record. */
function customOf(event: HarnessEvent): { eventType: string; payload: Record<string, unknown> } | null {
  const data = event?.data;
  if (data?.type !== EventKind.Custom || typeof data.event_type !== "string") return null;
  const payload = data.payload && typeof data.payload === "object" ? (data.payload as Record<string, unknown>) : {};
  return { eventType: data.event_type, payload };
}

/** The text a steer quotes, trimmed, or empty. */
const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * The texts of the run's steers that are the person's own words: one a run's lead took from the
 * person's message as it was (`how: lead`), or one whose words are the person's message it came from.
 */
function personsWords(events: readonly HarnessEvent[], runId: string): Set<string> {
  const { messages } = messageQueueState(events);
  const words = new Set<string>();
  for (const event of events) {
    const record = customOf(event);
    if (record?.eventType !== RunEvent.RunSteering || record.payload.runId !== runId) continue;
    const text = textOf(record.payload.text);
    const source = typeof record.payload.sourceMessageId === "string" ? record.payload.sourceMessageId : null;
    const asked = source ? textOf(messages.get(source)?.action?.text) : "";
    // A kept steer-delivery.ts from before live chat has no `Lead`: an absent `how` never matches it.
    const toTheLead = record.payload.how !== undefined && record.payload.how === SteerDelivery.Lead;
    const verbatim = toTheLead || (asked !== "" && asked === text);
    if (text && verbatim) words.add(text);
  }
  return words;
}

/** The newest round of the run's finish checks in the log, 0 without one. */
function lastRoundOf(events: readonly HarnessEvent[], runId: string): number {
  let last = 0;
  for (const event of events) {
    const record = customOf(event);
    if (record?.eventType !== FINISH_CHECK_EVENT || record.payload.runId !== runId) continue;
    const round = record.payload.round;
    if (typeof round === "number" && Number.isSafeInteger(round) && round > last) last = round;
  }
  return last;
}

/** The run's log as a finish check reads it: `listed` (the inbox's messages to the run) split by whose words they are. */
export async function readFinishLog(
  ctx: HarnessCtx,
  threadId: string,
  runId: string,
  listed: readonly string[],
): Promise<FinishLog> {
  const answer = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => null);
  const events: HarnessEvent[] = Array.isArray(answer) ? answer : [];
  const person = personsWords(events, runId);
  const said = listed.filter((text) => person.has(textOf(text)));
  const relayed = listed.filter((text) => !person.has(textOf(text)));
  return { said, relayed, lastRound: lastRoundOf(events, runId) };
}
