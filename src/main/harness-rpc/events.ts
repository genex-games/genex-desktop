/** Harness RPC: the event log, threads, artifacts and turns. */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { inboxOf } from "../core/inbox.ts";
import { refuseHostRecords, vouchedInteractions } from "../core/harness-events.ts";
import { threadOr } from "../core/main-thread.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** Why an event call from the harness is refused. */
const MESSAGE = {
  unknownTurn: (turnId: string) => `unknown turn: ${turnId}`,
  harnessRestarted: "the harness restarted before this turn began",
} as const;

export function eventsRpc(core: StudioCore, x: CoreInternals) {
  return {
    // — event log —
    [HostMethod.EventsAppend]: async (p) => {
      const threadId = threadOr(core, p.threadId);
      refuseHostRecords(p.batch);
      const latest = await core.append(vouchedInteractions(p.batch), threadId);
      await x.rewind.forgetCompactedSession(threadId, p.batch);
      x.rewind.checkpointQueueRecords(threadId, p.batch);
      // A message the queue answered or took back is nobody's to answer any more; one still
      // queued outlives a Stop.
      x.permissions.followQueueRecords(threadId, p.batch);
      return latest;
    },
    // A rewound chat reads without its withdrawn rows and sessions (`core/rewind.ts`).
    [HostMethod.EventsList]: async (p) => {
      const threadId = threadOr(core, p.threadId);
      const events = await core.store.listEvents(threadId, {
        ...(p.after ? { after: p.after } : {}),
        ...(p.limit ? { limit: p.limit } : {}),
      });
      return x.rewind.harnessView(threadId, events);
    },
    [HostMethod.EventsHead]: async (p) => core.store.head(threadOr(core, p.threadId)),
    [HostMethod.EventsMessages]: async (p) => x.rewind.harnessMessages(threadOr(core, p.threadId)),
    [HostMethod.EventsInbox]: async () => inboxOf(core.store).pending(core.store),
    [HostMethod.ThreadMain]: async () => core.mainThread,
    // A title and nothing else: a thread's kind, game, id and permission mode are the host's to
    // set. A harness that could write them could make a thread of its own read as the person's chat.
    [HostMethod.ThreadCreate]: async (p) =>
      core.store.createThread(typeof p?.title === "string" ? { title: p.title } : {}),
    [HostMethod.ThreadList]: async () => core.store.listThreads(),
    [HostMethod.ThreadFork]: async (p) =>
      core.store.forkThread(p.threadId, p.upToInclusive, p.title ? { title: p.title } : {}),
    [HostMethod.ArtifactRead]: async (p) => core.store.readArtifact(threadOr(core, p.threadId), p.artifactId),
    [HostMethod.ArtifactWrite]: async (p) =>
      core.store.writeArtifact(threadOr(core, p.threadId), p.artifactId, p.value),
    // — turns —
    [HostMethod.TurnBegin]: async (p) => {
      const threadId = threadOr(core, p.threadId);
      // Nothing of the answer runs before the folder it may change has been saved.
      const generation = x.harnessGeneration;
      await x.rewind.checkpointBefore(threadId);
      // The loop that asked is gone (restarted while this waited): no turn for it to end.
      if (generation !== x.harnessGeneration) throw new Error(MESSAGE.harnessRestarted);
      const turn = await core.turns.beginTurn(threadId, {
        ...(p.input ? { input: p.input } : {}),
        ...(p.metadata ? { metadata: p.metadata } : {}),
      });
      if (generation !== x.harnessGeneration) {
        await turn.end("cancelled").catch(() => {});
        throw new Error(MESSAGE.harnessRestarted);
      }
      x.openTurns.set(turn.turnId, turn);
      return { turnId: turn.turnId, sessionId: turn.sessionId, head: turn.latestEventId };
    },
    [HostMethod.TurnAppend]: async (p) => {
      const turn = x.openTurns.get(p.turnId);
      if (!turn) throw new Error(MESSAGE.unknownTurn(p.turnId));
      refuseHostRecords(p.batch);
      const { latestEventId, events } = await turn.write(p.batch);
      for (const event of events) x.indexEvent(event);
      return latestEventId;
    },
    [HostMethod.TurnEnd]: async (p) => {
      const turn = x.openTurns.get(p.turnId);
      if (!turn) return null;
      const head = await turn.end(p.status ?? "ok", p.outcome ? { outcome: p.outcome } : undefined);
      x.openTurns.delete(p.turnId);
      return head;
    },
  } satisfies Partial<HarnessHostHandlers>;
}
