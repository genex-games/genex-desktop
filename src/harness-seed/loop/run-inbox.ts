import { messageQueueState } from "./message-queue.ts";
import type { AnyRecord, HarnessCtx, HarnessEvent } from "../types/harness.d.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind, RunEvent, RunState, SteeringSource } from "./run-events.ts";
import { SteerDelivery } from "./steer-delivery.ts";

/** What a `run_control` record asks of a run. Persisted: never rename a value. */
export const RunControlAction = {
  /** Wrap up: let the current attempts finish, then integrate and show what is ready. */
  Finish: "finish",
} as const;
export type RunControlAction = (typeof RunControlAction)[keyof typeof RunControlAction];

/** The events that say a run exists on a thread: registered from chat, or started. */
const RUN_OPENED: readonly string[] = [RunEvent.RunRegistered, RunEvent.RunStarted];
/** The run's latest events a snapshot shows as its progress. */
const RECENT_PROGRESS_EVENTS = 24;
/** The run's events that are progress: its facets, phases, integration, director, stage, controls and steers. */
const PROGRESS_EVENT = /facet_|autopilot_|integration_|director_|optimization_updated|run_control|run_steering/;
/**
 * Its events that are not, though they look it: a wake of the lead is the lead being told, not
 * the run moving, and with up to thirty an hour they pushed the workers' own events off the list;
 * so did a steer's hand-over, two for every chat message a run's lead takes (live chat).
 */
const NOT_PROGRESS: readonly string[] = [RunEvent.DirectorContinued, RunEvent.RunSteeringDelivered];

/** Does a snapshot show this event as the run's progress? */
const isProgress = (eventType: string): boolean => PROGRESS_EVENT.test(eventType) && !NOT_PROGRESS.includes(eventType);
/** Where an unaddressed steer is handed over: the build's next brief, not one worker. */
const BUILD_ADDRESS = "build";

/** Durable run identity and addressed control messages, shared by the host and harness. */
export const coordinatorTools = [
  {
    name: "run_status",
    description: "Read the current run, worker progress and recent checks. This does not start or stop work.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "steer_run",
    description:
      "Send a concrete instruction to the existing workers at their next iteration boundary. Use only for requested changes, not questions or status requests.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The user's requested change, with enough context for a worker." },
        facetId: { type: "string", description: "Optional facet id; omit to address every worker." },
      },
      required: ["text"],
    },
  },
  {
    name: "finish_run",
    description:
      "Finish the current attempts, then integrate and check the accepted work and show it live. No new facet rounds, no reset, no cancellation. Use when the user asks to wrap up or wait for the remaining workers and show what is ready.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "resume_run",
    description:
      "Continue a paused run with its saved plan and completed work when the user requests further work, including a new instruction after Stop. Supply that instruction as text before builders resume. Questions alone do not resume work.",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Optional run id from availableRuns, when resuming an earlier paused build.",
        },
        text: {
          type: "string",
          description: "The latest requested change or continuation, preserving the user's intent.",
        },
      },
    },
  },
  {
    name: "continue_build",
    description:
      "Continue implementation in this game's existing conversation after the run has finished. Use for a requested change or unfinished work, never a question. The saved plan and results are retained; this does not repeat intake or create a new timed run.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to implement next, incorporating the latest user message." },
        build: {
          type: "boolean",
          description:
            "false for a contained change (a fix, a tweak, one feature): one builder makes it in this chat and the build stays finished. Omit to continue the build itself.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "show_build",
    description:
      "Open a build in Live, the game view on the right of this chat, without changing the game folder: integration (what the run built, landed or not), live (the game folder as it is), or a commit hash. Use only when the user asks to see, run, play or launch what a run made, including after the run has finished or paused; never to show your own edits, which the stage's Reload button offers by itself. Afterwards say what it answered: open in Live, or waiting behind Reload while the user watches Live.",
    parameters: {
      type: "object",
      properties: { build: { type: "string", description: "live, integration (default), or a commit hash." } },
    },
  },
  {
    name: "land_build",
    description:
      "Put a build in the game folder: merge what the run built (integration, the default) or a named commit into the folder the user plays from; Live shows it at once or through its Reload button, as the answer says. Only for a run that has finished or paused; use finish_run while it is running. Refuses when the game folder has uncommitted edits.",
    parameters: {
      type: "object",
      properties: { build: { type: "string", description: "integration (default) or a commit hash." } },
    },
  },
];

/** The run the log describes: the newest one, or `targetRunId`, folded from its own events. */
export function latestRun(events: readonly HarnessEvent[], targetRunId: string | null = null): AnyRecord | null {
  let run = null as AnyRecord | null;
  for (const event of events) {
    const d = event?.data;
    if (d?.type !== EventKind.Custom) continue;
    const p = d.payload ?? {};
    if (targetRunId && p.runId !== targetRunId) continue;
    run = foldRunEvent(run, d.event_type, p);
  }
  return run;
}

/** The run after one of its custom events: opened, finished, paused or resumed. */
function foldRunEvent(run: AnyRecord | null, type: string, p: AnyRecord): AnyRecord | null {
  const opened = RUN_OPENED.includes(type)
    ? { ...(run?.runId === p.runId ? run : {}), ...p, state: RunState.Running }
    : run;
  if (p.runId !== opened?.runId) return opened;
  if (type === RunEvent.RunFinished) return { ...opened, ...p, state: RunState.Finished };
  if (type === RunEvent.AutopilotPaused) return { ...opened, state: RunState.Paused };
  if (type === RunEvent.AutopilotResumed) return { ...opened, state: RunState.Running };
  return opened;
}

export function runSnapshot(
  events: readonly HarnessEvent[],
  runId: string,
): { run: AnyRecord; availableRuns: AnyRecord[]; progress: AnyRecord[] } {
  const current = latestRun(events);
  const recent = events.filter((e) => e.data?.type === EventKind.Custom && e.data.payload?.runId === runId);
  return {
    run: current?.runId === runId ? current : { runId, state: RunState.Superseded },
    availableRuns: [
      ...new Set(
        events
          .filter((e) => RUN_OPENED.includes((e.data as AnyRecord)?.event_type))
          .map((e) => (e.data as AnyRecord).payload?.runId)
          .filter(Boolean),
      ),
    ].map((id) => {
      const run = latestRun(events, id);
      return { runId: id, project: run?.project, goal: run?.goal, state: run?.state };
    }),
    progress: recent
      .filter((e) => isProgress((e.data as AnyRecord).event_type))
      .slice(-RECENT_PROGRESS_EVENTS)
      .map((e) => ({ type: (e.data as AnyRecord).event_type, ...(e.data as AnyRecord).payload })),
  };
}

/** Future queued user input must not leak into an earlier coordinator turn's prompt. */
export function conversationThrough(events: readonly HarnessEvent[], messageId?: string | null): HarnessEvent[] {
  const { messages } = messageQueueState(events);
  const byEvent = new Map([...messages.values()].filter((m) => m.eventId).map((m) => [m.eventId, m]));
  let reached = false;
  const omit = new Set<string | null>();
  for (const message of messages.values()) {
    if (message.state === "removed" || reached) omit.add(message.eventId);
    if (messageId && message.messageId === messageId) reached = true;
  }
  return events
    .filter((e) => !omit.has(e.id))
    .map((e) => {
      const message = byEvent.get(e.id);
      if (!message?.action?.text || e.data?.type !== EventKind.Messages) return e;
      return {
        ...e,
        data: {
          ...e.data,
          messages: e.data.messages.map((m) => (m.role === "user" ? { ...m, content: message.action!.text } : m)),
        },
      };
    });
}

/** One steer the user sent a run: the event it came in, its payload, and when the event was logged. */
type Steer = AnyRecord & { id: string; loggedAt?: string | null };

/** What a run's log says so far: whether this session was asked to wrap up, the steers, and who got them. */
interface InboxFold {
  finishing: boolean;
  instructions: Steer[];
  /** `<steer id>:<address>` for every steer handed to a worker or to the build's next brief. */
  delivered: Set<string>;
  /** Every steer handed to anybody. */
  consumed: Set<string>;
  /**
   * The chat's messages a run's lead took (live chat) that are settled for the run: the lead heard
   * them, or they went back to the chat, which answered them. A later run never tells them again.
   */
  settledByLead: Set<string>;
}

function emptyInboxFold(): InboxFold {
  return { finishing: false, instructions: [], delivered: new Set(), consumed: new Set(), settledByLead: new Set() };
}

/** The key a hand-over is remembered by: the steer and where it went. */
const deliveryKey = (steerId: string, address: string | undefined): string => `${steerId}:${address ?? BUILD_ADDRESS}`;

/**
 * Take in one event of the run's thread, in log order. A registration opens a session of the run
 * (a resume registers again), and a wrap-up asked of an earlier session is not this one's: a
 * resumed run that inherited it would skip every builder. A hand-over, by any session, is
 * durable, so a resumed session never hands a steer over twice.
 */
function absorbInboxEvent(fold: InboxFold, event: HarnessEvent, runId: string): void {
  const d = event?.data;
  if (d?.type !== EventKind.Custom) return;
  const p = d.payload ?? {};
  // A message a run's lead never heard went back to the chat, which answers it (live chat).
  if (d.event_type === RunEvent.CoordinatorMessageRequeued) settleLeadSteers(fold, p.messageId);
  if (p.runId !== runId) return;
  if (d.event_type === RunEvent.RunRegistered) fold.finishing = false;
  if (d.event_type === RunEvent.RunControl && p.action === RunControlAction.Finish) fold.finishing = true;
  // The director's own worker_steer events are steering too — but its own, not the
  // user's (a director must never ask the user to repeat an instruction it wrote itself).
  const userSteer = d.event_type === RunEvent.RunSteering && p.text?.trim() && p.source !== SteeringSource.Director;
  if (userSteer) fold.instructions.push({ id: event.id, ...p, loggedAt: event.created_at ?? null });
  if (d.event_type === RunEvent.RunSteeringDelivered) absorbDelivery(fold, p);
}

/**
 * Was this handed to a run's lead (live chat)? A kept steer-delivery.ts from before live chat has
 * no `Lead`, and an ordinary hand-over records no `how`: those two must not read as equal.
 */
function toTheLead(how: unknown): boolean {
  return how !== undefined && how === SteerDelivery.Lead;
}

/** A steer handed over (to a worker, or to the build's next brief) — or a chat message a run's lead heard. */
function absorbDelivery(fold: InboxFold, p: AnyRecord): void {
  if (toTheLead(p.how)) {
    settleLeadSteers(fold, p.sourceMessageId);
    return;
  }
  if (!p.messageId) return;
  fold.delivered.add(deliveryKey(p.messageId, p.facetId));
  fold.consumed.add(p.messageId);
}

/**
 * The steers a run's lead took from this chat message so far are settled for the run (live
 * chat): heard, or back with the chat. One recorded later from the same message — the chat's own
 * `resume_run` — is new.
 */
function settleLeadSteers(fold: InboxFold, messageId: unknown): void {
  if (!messageId) return;
  for (const steer of fold.instructions)
    if (toTheLead(steer.how) && steer.sourceMessageId === messageId) fold.settledByLead.add(steer.id);
}

/** Has the run's current session (since its latest registration) been asked to wrap up? */
export function finishRequested(events: readonly HarnessEvent[], runId: string): boolean {
  const fold = emptyInboxFold();
  for (const event of events) absorbInboxEvent(fold, event, runId);
  return fold.finishing;
}

/**
 * Reads the run's thread from `after` (the whole log by default), so input during planning or
 * base creation survives, and so does what an earlier session of the same run handed over. A chat
 * message a run's lead heard, or that went back to the chat, is not told to a later run.
 */
export function createRunInbox(
  ctx: HarnessCtx,
  { threadId, runId, after = null }: { threadId: string; runId: string; after?: string | null },
) {
  let cursor = after;
  let draining: Promise<void> | null = null;
  const fold = emptyInboxFold();
  // `<steer id>:<address>` a consuming `steering` of this inbox has answered with. `onlyNew` is
  // once per inbox (one run), not per run: a resumed run whose director restarts in a fresh
  // session must still hear a steer an earlier run's director was told, while the durable
  // hand-over keeps it from being recorded twice.
  const told = new Set<string>();
  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      const events = await ctx.call(HostMethod.EventsList, { threadId, ...(cursor ? { after: cursor } : {}) });
      for (const event of events) absorbInboxEvent(fold, event, runId);
      const last = events.at(-1);
      if (last) cursor = last.id;
    })().finally(() => {
      draining = null;
    });
    return draining;
  }
  /**
   * Remember steers as delivered, then record them as handed over (stage `next brief` or `now`).
   * Remembered first, in the step that chose them: a second reader arriving while the record is
   * written must not take them too. A record the log refuses forgets them again.
   */
  async function handOver(steers: Array<{ steer: Steer; address: string }>, stage: string): Promise<void> {
    const keys = steers.map(({ steer, address }) => deliveryKey(steer.id, address));
    const fresh = keys.filter((key) => !fold.delivered.has(key));
    const freshConsumed = steers.map(({ steer }) => steer.id).filter((id) => !fold.consumed.has(id));
    for (const key of fresh) fold.delivered.add(key);
    for (const id of freshConsumed) fold.consumed.add(id);
    if (!steers.length) return;
    try {
      await ctx.call(HostMethod.EventsAppend, {
        threadId,
        batch: steers.map(({ steer, address }) => ({
          type: EventKind.Custom,
          event_type: RunEvent.RunSteeringDelivered,
          payload: { runId, messageId: steer.id, facetId: address, text: steer.text, stage },
        })),
      });
    } catch (err) {
      for (const key of fresh) fold.delivered.delete(key);
      for (const id of freshConsumed) fold.consumed.delete(id);
      throw err;
    }
  }
  const isNew = (steer: Steer, address: string) => !fold.delivered.has(deliveryKey(steer.id, address));
  /** Answer `selected` for `address`: told at once, handed over durably, forgotten if that fails. */
  async function consumeFor(selected: Steer[], address: string): Promise<void> {
    const toldNow = selected.map((i) => deliveryKey(i.id, address)).filter((key) => !told.has(key));
    for (const key of toldNow) told.add(key);
    try {
      await handOver(
        selected.filter((i) => isNew(i, address)).map((steer) => ({ steer, address })),
        "next brief",
      );
    } catch (err) {
      for (const key of toldNow) told.delete(key);
      throw err;
    }
    for (const item of selected) fold.consumed.add(item.id);
  }
  return {
    async finishing() {
      await drain();
      return fold.finishing;
    },
    /**
     * The steers for one worker's brief (`facetId`) or the build's (none): the unaddressed ones and
     * those addressed to it, every one so far unless only the ones this inbox has not answered
     * with yet are asked for. Only the ones no session handed over yet are recorded as handed over.
     */
    async steering(
      facetId?: string,
      consume = true,
      { onlyNew = false }: { onlyNew?: boolean } = {},
    ): Promise<string[]> {
      await drain();
      const address = facetId ?? BUILD_ADDRESS;
      const selected = fold.instructions.filter((i) => !i.facetId || i.facetId === facetId);
      const untold = selected.filter((i) => !told.has(deliveryKey(i.id, address)) && !fold.settledByLead.has(i.id));
      if (consume) await consumeFor(selected, address);
      return (onlyNew ? untold : selected).map((i) => i.text);
    },
    /**
     * The user's steers addressed to one worker (`facetId`), and only those. `steering(undefined)`
     * — the director's own drain — keeps the unaddressed ones by design, so nothing in a
     * director's run ever read these: they were written, acknowledged in the chat, and
     * delivered to nobody. Consuming answers with the ones not handed over yet, so a caller can
     * poll it.
     */
    async addressed(consume = true): Promise<Array<{ facetId: string; text: string }>> {
      await drain();
      const selected = fold.instructions.filter((i) => i.facetId);
      if (!consume) return selected.map((i) => ({ facetId: i.facetId, text: i.text }));
      const fresh = selected.filter((i) => isNew(i, i.facetId));
      await handOver(
        fresh.map((steer) => ({ steer, address: steer.facetId })),
        "now",
      );
      return fresh.map((i) => ({ facetId: i.facetId, text: i.text }));
    },
    /**
     * The steers `steering(facetId, false)` reads, each with when its event was logged (ISO, or
     * null when the log did not say). Time orders them against something said outside the inbox —
     * a card the lead posted — whichever part of the log this inbox reads from.
     */
    async sentSteering(facetId?: string): Promise<Array<{ text: string; at: string | null }>> {
      await drain();
      return fold.instructions
        .filter((i) => !i.facetId || i.facetId === facetId)
        .map((i) => ({ text: i.text, at: i.loggedAt ?? null }));
    },
    async backlog(): Promise<string[]> {
      await drain();
      return fold.instructions.filter((i) => !fold.consumed.has(i.id)).map((i) => i.text);
    },
  };
}

/** A run's inbox: the user's steers and finish request, read from the run's cursor on. */
export type RunInbox = ReturnType<typeof createRunInbox>;
