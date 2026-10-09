/**
 * What a freshly started harness does with the host's boot notice: record why it is awake, leave
 * itself a note after a crash or a rewind, close the runs its previous self died in, and pick
 * the unanswered messages back up.
 */
import { loadSkills } from "./skills.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind, JournalPhase, RunEvent } from "./run-events.ts";
import { journalId, readJournal } from "./run-journal.ts";
import { restartNote } from "./studio-prompts.ts";
import type { Studio } from "./studio-state.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { AnyRecord, HarnessEvent, Host } from "../types/harness.d.ts";
import type { BootNotice } from "../types/host-api.d.ts";

/** Why the host started this harness (`BootNotice.reason`). Wire values: never rename one. */
export const BootReason = {
  ColdStart: "cold_start",
  SelfUpdate: "self_update",
  WatchdogRestore: "watchdog_restore",
  CrashRestart: "crash_restart",
} as const satisfies Record<string, BootNotice["reason"]>;
export type BootReason = (typeof BootReason)[keyof typeof BootReason];

/** What a run that died with its loop is told it ended of — plain, and true of any crash. */
const CRASHED = "the studio's loop crashed and restarted";

/** The boots after which the workspace may not be the one the last self was running. */
const REWINDING_BOOTS = new Set<string>([BootReason.WatchdogRestore, BootReason.CrashRestart]);

/**
 * The reborn agent reads its own restart from its own log; this notice only tells it *why* it
 * is awake so it can decide what to do first (resume a run, apologise for a broken edit…).
 */
export async function handleBootNotice(studio: Studio, messages: MessageQueue, notice: BootNotice): Promise<void> {
  const { host } = studio;
  host.notify("harness.boot", notice);
  const skills = await loadSkills(host.workspace);
  await host.call(HostMethod.EventsAppend, {
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.HarnessBooted,
        payload: { reason: notice.reason, detail: notice.detail ?? null, skills: skills.map((s) => s.name) },
      },
    ],
  });
  if (REWINDING_BOOTS.has(notice.reason)) {
    // Leave a first-person trace so the next prompt materialisation includes what happened.
    await host.call(HostMethod.EventsAppend, {
      batch: [
        {
          type: EventKind.Messages,
          messages: [{ role: "system", content: restartNote(notice.reason, notice.detail) }],
        },
      ],
    });
  }
  // A run the previous self was in the middle of has nobody left to judge or land it: close
  // it in its own thread before anything else, so the chat stops claiming it is still working.
  await closeRunsOrphanedByCrash(studio, notice.openRuns).catch(() => {});
  // Replay unanswered inbox entries in order. Completed requests are never re-enqueued. The host
  // hands over only the queue records still open, not every conversation's whole log.
  // Each conversation on its own: one whose queue cannot be put back must not leave every other
  // one unanswered. Its records stay in the log for the next boot to try again.
  for (const { threadId, events } of await host.call(HostMethod.EventsInbox, {}).catch(() => [])) {
    await messages.restore(threadId, events).catch(async (err: unknown) => {
      const message = QUEUE_NOT_RESTORED(err instanceof Error ? err.message : String(err));
      await host
        .call(HostMethod.EventsAppend, { threadId, batch: [{ type: EventKind.Error, message }] })
        .catch(() => {});
    });
  }
}

/** What a conversation is told when its unanswered messages could not be put back after a restart. */
const QUEUE_NOT_RESTORED = (why: string) =>
  `Studio restarted and could not put this chat's unanswered messages back in line (${why}). Send them again.`;

/**
 * The runs the harness that just died was in the middle of, named by the host. Nothing they
 * briefed can be judged, committed or landed any more — the host aborted every contractor the
 * moment the child exited — so each one gets its ending where the user is looking: in its own
 * game's thread, never in the studio's. "Paused", not "failed": the journal still holds the
 * run's integration head, so the morning card can offer the build and Resume can pick the
 * run up from it. A run whose thread already carries an ending is left alone — the app
 * repairs interrupted logs at boot as well, and closing twice would overwrite a real close.
 */
async function closeRunsOrphanedByCrash(studio: Studio, runIds: string[] | null | undefined): Promise<void> {
  const wanted = new Set((runIds ?? []).filter(Boolean));
  if (wanted.size === 0) return;
  const { host } = studio;
  for (const thread of await host.call(HostMethod.ThreadList, {}).catch(() => [])) {
    const events = await host.call(HostMethod.EventsList, { threadId: thread.id }).catch(() => []);
    const { started, closed } = runsIn(events);
    for (const [runId, payload] of started) {
      if (!wanted.has(runId)) continue;
      // Whatever the log says, Stop must still be able to reach this run's builders.
      if (payload.project) studio.orphanRuns.set(runId, payload.project);
      if (closed.has(runId) || runsItAgain(studio, runId)) continue;
      await closeOrphan(host, thread.id, runId, payload);
    }
  }
}

/**
 * Is this loop running the run again itself (a Resume or a reopen taken as it woke)? The host names a
 * run in flight at every later crash of the app's session, so the name can be stale: the run is
 * this loop's, never one to close under it.
 */
function runsItAgain(studio: Studio, runId: string): boolean {
  return Boolean(studio.activeRuns?.has(runId) || studio.startingRuns?.has(runId));
}

/** The runs a thread's log started (with the payload that started them) and the ones it closed. */
function runsIn(events: readonly HarnessEvent[]): { started: Map<string, AnyRecord>; closed: Set<string> } {
  const started = new Map<string, AnyRecord>();
  const closed = new Set<string>();
  for (const e of events) {
    const d = e?.data;
    if (d?.type !== EventKind.Custom || !d.payload?.runId) continue;
    // A director's run registers as "autopilot" and then starts as "director"; the last
    // word wins here exactly as it does in the app's own boot repair, so both agree. A run
    // started again (a Resume, a finished build reopened) is open again: an earlier session's
    // close is not this one's.
    if (d.event_type === RunEvent.RunStarted || d.event_type === RunEvent.RunRegistered) {
      started.set(d.payload.runId, d.payload);
      closed.delete(d.payload.runId);
    }
    if (d.event_type === RunEvent.RunFinished) closed.add(d.payload.runId);
  }
  return { started, closed };
}

/** End one orphaned run in its own thread: paused when its journal can resume it, else just closed. */
async function closeOrphan(host: Host, threadId: string, runId: string, payload: AnyRecord): Promise<void> {
  const journal = await readJournal(host, threadId, runId);
  const paused = Boolean(journal) && journal?.phase !== JournalPhase.Done;
  if (paused)
    await host
      .call(HostMethod.ArtifactWrite, {
        threadId,
        artifactId: journalId(runId),
        value: { ...journal, phase: JournalPhase.Paused },
      })
      .catch(() => {});
  const project = payload.project ? { project: payload.project } : {};
  await host
    .call(HostMethod.EventsAppend, {
      threadId,
      batch: [
        {
          type: EventKind.Custom,
          event_type: RunEvent.RunFinished,
          payload: {
            runId,
            ...project,
            ...(payload.goal ? { goal: payload.goal } : {}),
            ...(payload.mode ? { mode: payload.mode } : {}),
            victory: false,
            stoppedBecause: CRASHED,
            finishedAt: new Date().toISOString(),
            ...(paused ? unlandedBuild(journal, runId) : {}),
          },
        },
        ...(paused
          ? [{ type: EventKind.Custom, event_type: RunEvent.AutopilotPaused, payload: { runId, ...project } }]
          : []),
      ],
    })
    .catch(() => {});
}

/**
 * The build a paused run leaves to play, when it merged one. Only claim a build when the run
 * actually merged one: a head still standing on the starting point is nothing to play, and
 * promising one leaves the card with no button.
 */
function unlandedBuild(journal: AnyRecord | null, runId: string): AnyRecord {
  const head = journal?.director?.integrationHead ?? journal?.integrationHead ?? null;
  const base = journal?.director?.baseCommit ?? null;
  const merged = typeof head === "string" && head && head !== base;
  if (!merged) return {};
  return {
    landed: false,
    integrationHead: head,
    integrationRef: `refs/studio/runs/${runId}/integration`,
    ...(typeof base === "string" ? { baseCommit: base } : {}),
  };
}
