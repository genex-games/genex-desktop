/** Resolve a worker question from host call attribution and the persisted run starts. */
import { customRecord, CustomEvent } from "../../shared/custom-events.ts";
import { isDeepStrictEqual } from "node:util";
import { EventKind } from "../../shared/event-log.ts";
import type { EventEnvelope } from "../../substrate/types.ts";
import type { PluginBinding } from "../../shared/plugins.ts";
import type { StudioCore } from "../studio-core.ts";

/** Never choose a parent by project alone: concurrent runs may have different conversations. */
export async function consentAudience(core: StudioCore, binding: PluginBinding, runId?: string): Promise<string> {
  const origin = binding.threadId ?? core.mainThread;
  if (!runId || !binding.threadId) return origin;
  const starts = (await core.activityEvents()).filter((event) => {
    const record = customRecord(event.data);
    const startsRun = record?.event_type === CustomEvent.RunStarted || record?.event_type === CustomEvent.RunRegistered;
    return startsRun && record.payload.runId === runId;
  });
  const parents = new Set(starts.map((event) => event.thread_id));
  if (parents.size !== 1) return origin;
  const parent = starts[0]?.thread_id;
  if (!parent) return origin;
  const record = await core.store.getRecord(parent);
  if (record.metadata?.project !== binding.project) return origin;
  const wrongProject = starts.some((event) => {
    const project = customRecord(event.data)?.payload.project;
    return project !== undefined && project !== binding.project;
  });
  return wrongProject ? origin : parent;
}

/**
 * A declined run prerequisite is not asked again until the user explicitly resumes that run; a
 * chat's declined call, not until the user's next message — a model that asked again at once got
 * a new card for the same no, as often as it asked. Only the user's own no counts: a card nobody
 * answered is not a no, and the agent was told it may ask again later.
 */
export async function priorConsentDecline(
  core: StudioCore,
  threadId: string,
  runId: string | undefined,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ approved: false; by: "user" } | null> {
  const events = await core.store.listEvents(threadId);
  if (!runId) return chatDecline(events, tool, args);
  for (const event of events.toReversed()) {
    const record = customRecord(event.data);
    if (record?.payload.runId !== runId) continue;
    if (record.event_type === CustomEvent.AutopilotResumed) return null;
    if (record.event_type !== CustomEvent.PluginConsent || record.payload.tool !== tool) continue;
    if (!isDeepStrictEqual(record.payload.args, args)) continue;
    const decline = declinedDecision(record.payload.state, record.payload.by);
    if (decline) return decline;
    if (record.payload.state === "approved") return null;
  }
  return null;
}

/** The same call declined since the user last spoke in this chat, if it was. */
function chatDecline(
  events: readonly EventEnvelope[],
  tool: string,
  args: Record<string, unknown>,
): { approved: false; by: "user" } | null {
  for (const event of events.toReversed()) {
    if (userSpoke(event)) return null;
    const record = customRecord(event.data);
    if (record?.event_type !== CustomEvent.PluginConsent || record.payload.runId) continue;
    if (record.payload.tool !== tool || !isDeepStrictEqual(record.payload.args, args)) continue;
    return declinedDecision(record.payload.state, record.payload.by);
  }
  return null;
}

/** A message of the user's in the log. */
function userSpoke(event: EventEnvelope): boolean {
  return event.data.type === EventKind.Messages && event.data.messages.some((message) => message.role === "user");
}

/** The user's own no; a stop, a restart or a card nobody answered is not one. */
function declinedDecision(state: unknown, by: unknown): { approved: false; by: "user" } | null {
  return state === "declined" && by === "user" ? { approved: false, by } : null;
}
