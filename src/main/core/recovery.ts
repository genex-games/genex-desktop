/**
 * Recovery: closing work a dead harness left open, the watchdog's rewind to the last healthy self,
 * reseeding from the app, crash repair, and the snapshots and health marks all of it relies on.
 * Composed by `StudioCore`; its state stays in the core.
 */
import { CallCutOff, type PluginConsentEvent } from "../../shared/plugins.ts";
import { PluginCallCutOff } from "../../substrate/plugins/process.ts";
import { ToolPermissionBy, type ToolPermissionEvent, ToolPermissionState } from "../../shared/permissions.ts";
import type { OptimizationCheckpointV1, OptimizationResultV1 } from "../../shared/optimization.ts";
import path from "node:path";
import { interruptedReplyNotice } from "../../shared/message-queue.ts";
import { cp, readdir, rm } from "node:fs/promises";
import { shortId } from "../../substrate/ids.ts";
import { RUNS_AS_CODE } from "../self-changes.ts";
import {
  type ApplySeedOptions,
  type LayoutMigrationReport,
  applySeed,
  layoutMigrationPending,
  migrateHarnessLayout,
  reconcileManifestWithSeedVintages,
  recordLayoutAttempt,
  removeLegacyModules,
  type SeedUpgradeReport,
} from "../../substrate/seed-upgrade.ts";
import { type TypeCheckResult, diagnosticsFor, typeCheckText, TypeCheckFailure } from "../../substrate/type-gate.ts";
import type { ForkBoot } from "./self-edit-gate.ts";
import { seedCallMemory, seedMoveMemory } from "../seed-upgrade-notice.ts";
import { type SnapshotRecord, HARNESS_WORKSPACE } from "../../substrate/snapshots.ts";
import type { ThreadFold } from "../../substrate/event-store.ts";
import { interruptedTurnsIn } from "../../substrate/turns.ts";
import { type InboxState, foldInbox, inboxOf } from "./inbox.ts";
import type { EventData, EventEnvelope } from "../../substrate/types.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CustomEvent, customEventData, customRecord } from "../../shared/custom-events.ts";
import { EventKind, SnapshotScope } from "../../shared/event-log.ts";
import { BootReason, DispatchActionType } from "../../shared/protocol.ts";
import { RUN_START_EVENTS } from "../../shared/run-state.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { RetainedState } from "../../substrate/game-candidate.ts";

/** Words the recovery writes into the logs the user reads, and the errors it throws at them. */
const MESSAGE = {
  replyInterrupted: "This response was interrupted by a restart. Send a message to continue.",
  runInterrupted: "interrupted by restart",
  optimizationInterrupted: "Optimization interrupted by restart",
  optimizationNotApplied: "Optimization interrupted; unverified candidate changes were not applied",
  adoptionRecovered: "Verified optimization kept; adoption recovered after restart",
  liveFilesChanged: "Live files changed after the saved adoption intent; they were preserved",
  snapshotGone: "Studio no longer has that saved version.",
  buildInFlight: "Studio is building right now. Rewind when the build finishes.",
  rolledBackByUser: "rolled back by the user",
  rewindFailed: (failed: string) => `rewind failed: ${failed}`,
  reseedFailedToo: (failed: string, last: string) => `${failed}; reseeding failed too: ${last}`,
  watchdogFailed: (message: string) => `watchdog recovery failed: ${message}`,
  healthcheckFailed: "healthcheck failed",
  selfUpdateUnhealthy: (updateId: string) => `self-update ${updateId} failed its healthcheck`,
  selfUpdateThrew: (updateId: string, error: string) => `self-update ${updateId} threw: ${error}`,
} as const;

/** The seed manifest's file name in userData. */
const SEED_MANIFEST_FILE = "harness-seed-manifest.json";
/** The longest layout note the agent's memory keeps. */
const MEMORY_NOTE_MAX_CHARS = 400;
/** How much of the migrated harness's own type check reaches the log. */
const MIGRATION_LOG_MAX_LINES = 10;
/** How much of the agent's migrated-file type errors the migration record carries. */
const MIGRATION_TYPE_ERRORS_LIMIT = { maxLines: 20, maxChars: 2_000 } as const;
/** How long a queued self-restart waits, so the turn that asked for it can finish. */
const SELF_RESTART_GRACE_MS = 1.5 * SECOND_MS;

/**
 * The memory key of the note the layout migration leaves when the agent's migrated files have type
 * errors, or an edit of its no longer runs.
 */
export const LAYOUT_MEMORY_KEY = "app update moved your code to TypeScript";

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What the agent should hear about its own files after the layout migration, or null for nothing. */
export function layoutMemoryNote(
  done: Pick<LayoutMigrationReport, "replaced" | "stranded">,
  typeErrors: readonly string[],
): string | null {
  const parts: string[] = [];
  if (typeErrors.length > 0) {
    const files = [...new Set(typeErrors.map((line) => line.split("(")[0]))];
    parts.push(
      `Your edited ${files.join(", ")} kept their content and still run, but have ${plural(typeErrors.length, "type error")}. An edit is accepted only if it adds no new type error.`,
    );
  }
  if (done.replaced.length > 0)
    parts.push(
      `Your edited ${done.replaced.join(", ")} could not run as TypeScript, so the shipped version replaced it; your copy is backed up in Studio's updates folder.`,
    );
  if (done.stranded.length > 0)
    parts.push(
      `Your edited ${done.stranded.join(", ")} no longer run: a TypeScript file of the same name wins. They are backed up in Studio's updates folder.`,
    );
  return parts.length > 0 ? `An app update moved your code to TypeScript. ${parts.join(" ")}` : null;
}

/** A run's own words, as its start record gave them. */
interface RunWords {
  project?: string;
  goal?: string;
  mode?: string;
}

/** What the boot repair (`closeInterruptedWork`) needs from a conversation's log. */
interface RepairState {
  /** Turns begun and never ended, in the order they began. */
  turns: string[];
  /** Runs registered or started and never finished, with the run's own words; the last word wins. */
  runs: Array<[string, RunWords]>;
  /** Plugin consent questions still unanswered, in the order they were asked. */
  questions: Array<[string, PluginConsentEvent]>;
  /** Claude's tool permission questions still unanswered, by request id, in the order they were asked. */
  toolQuestions: Array<[string, ToolPermissionEvent]>;
  inbox: InboxState;
  /**
   * When the conversation's newest record was written: the last moment the app was there to work
   * on its runs. Absent from a checkpoint written before the fold kept it, until a record follows.
   */
  lastAt?: string;
}

/** The words a run record carries, without the fields it left out. */
function runWords(payload: RunWords): RunWords {
  return {
    ...(payload.project ? { project: payload.project } : {}),
    ...(payload.goal ? { goal: payload.goal } : {}),
    ...(payload.mode ? { mode: payload.mode } : {}),
  };
}

/** The questions a log leaves open: plugins' consents, and Claude's tool permissions. */
interface OpenQuestions {
  consents: Map<string, PluginConsentEvent>;
  tools: Map<string, ToolPermissionEvent>;
}

/** A `tool_permission` row: its first pending row opens the question, any settled row closes it. */
function foldToolQuestion(payload: Record<string, unknown>, open: Map<string, ToolPermissionEvent>): void {
  const question = payload as Partial<ToolPermissionEvent>;
  if (!question.requestId) return;
  if (question.state !== ToolPermissionState.Pending) open.delete(question.requestId);
  else if (!open.has(question.requestId)) open.set(question.requestId, question as ToolPermissionEvent);
}

/** One custom record's effect on the runs and the permission questions a log leaves open. */
function foldRepairRecord(data: EventData, runs: Map<string, RunWords>, open: OpenQuestions): void {
  const custom = customRecord(data);
  if (!custom) return;
  if (custom.event_type === CustomEvent.ToolPermission) {
    foldToolQuestion(custom.payload, open.tools);
    return;
  }
  const questions = open.consents;
  if (custom.event_type === CustomEvent.PluginConsent) {
    const question = custom.payload as Partial<PluginConsentEvent>;
    if (!question.consentId) return;
    if (question.state === "pending") questions.set(question.consentId, question as PluginConsentEvent);
    else questions.delete(question.consentId);
    return;
  }
  const payload = custom.payload as RunWords & { runId?: string };
  if (!payload.runId) return;
  if (RUN_START_EVENTS.has(custom.event_type)) runs.set(payload.runId, runWords(payload));
  if (custom.event_type === CustomEvent.RunFinished) runs.delete(payload.runId);
}

/**
 * The boot repair's fold, checkpointed per conversation (`repair-state.json`), so a launch reads
 * only what the last one did not. `run_finished` closes its `run_started` by runId, so a run a
 * boot already repaired, or the harness closed itself, is never closed twice.
 */
const REPAIR_FOLD: ThreadFold<RepairState> = {
  name: "repair-state",
  // 2: tool permission questions joined the fold, so a checkpoint without them is rebuilt.
  version: 2,
  fold: (previous, events) => {
    const runs = new Map(previous?.runs);
    const open: OpenQuestions = { consents: new Map(previous?.questions), tools: new Map(previous?.toolQuestions) };
    for (const event of events) foldRepairRecord(event.data, runs, open);
    const lastAt = events.at(-1)?.created_at ?? previous?.lastAt;
    return {
      turns: interruptedTurnsIn(events, previous?.turns),
      runs: [...runs],
      questions: [...open.consents],
      toolQuestions: [...open.tools],
      inbox: foldInbox(previous?.inbox ?? null, events),
      ...(lastAt ? { lastAt } : {}),
    };
  },
};

/**
 * The Studio conversation's snapshot records, which `StudioCore#indexEvent` builds the snapshot
 * index from: kept beside the log (`snapshot-records.json`) so a launch does not read it whole.
 * Keep the two in step.
 */
const SNAPSHOT_FOLD: ThreadFold<EventEnvelope[]> = {
  name: "snapshot-records",
  version: 1,
  fold: (previous, events) => [
    ...(previous ?? []),
    ...events.filter(
      (event) =>
        event.data.type === EventKind.SnapshotCreated ||
        (event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.SnapshotHealthy),
    ),
  ],
};

/** An unattended run's journal artifact (`autopilot_<runId>`), as far as the boot repair reads it. */
interface RunJournal {
  phase?: string;
  optimization?: OptimizationCheckpointV1;
  integrationHead?: string;
  director?: { integrationHead?: string; baseCommit?: string };
}

/** Where an interrupted run's merges wait, for the closure to offer (never landed yet). */
interface LoopRunLanding {
  landed: false;
  integrationHead: string;
  integrationRef: string;
  baseCommit?: string;
}

const journalArtifact = (runId: string): string => `autopilot_${runId}`;

/** An Optimization stage that was still deciding when the app died. */
function optimizationLeftOpen(cp: OptimizationCheckpointV1 | undefined): cp is OptimizationCheckpointV1 {
  return cp?.schemaVersion === 1 && Boolean(cp.result) && !cp.result.outcome;
}

/** Charge the budget segment the app died inside, and close it. */
function chargeInterruptedSegment(cp: OptimizationCheckpointV1, now: number): void {
  const { budget } = cp;
  if (!budget.activeSegmentStartedAt) return;
  const elapsed = Math.max(0, now - Date.parse(budget.activeSegmentStartedAt));
  budget.consumedMs = Math.min(budget.allocatedMs, budget.consumedMs + elapsed);
  if (cp.phase === "building_candidate")
    budget.workerConsumedMs = Math.min(budget.workerAllocatedMs, budget.workerConsumedMs + elapsed);
  budget.activeSegmentStartedAt = null;
}

/**
 * What the run got as far as, so the user can play it or make it live before deciding whether
 * to resume: the head is reachable on the run's ref whatever happened to the worktree. Only claim
 * a build when one exists and has moved — a classic run journals no head at all, and a director
 * killed before its first merge is still standing on the base. Saying "not made live yet" there
 * promises a build the morning card has nothing to offer.
 */
function loopRunLanding(runId: string, journal: RunJournal): LoopRunLanding | null {
  const head = journal.director?.integrationHead ?? journal.integrationHead ?? null;
  const base = journal.director?.baseCommit;
  const moved = typeof head === "string" && head && head !== base;
  if (!moved) return null;
  return {
    landed: false,
    integrationHead: head,
    integrationRef: `refs/studio/runs/${runId}/integration`,
    ...(typeof base === "string" ? { baseCommit: base } : {}),
  };
}

/** The `harness_layout_migrated` record of a migration that ran on the live workspace. */
function layoutMigratedPayload(done: LayoutMigrationReport, types: TypeCheckResult, theirs: readonly string[]) {
  return {
    ok: true,
    removed: done.removed,
    renamed: done.renamed,
    deleted: done.deleted,
    stranded: done.stranded,
    replaced: done.replaced,
    restored: done.restored,
    rewritten: done.rewritten,
    ...(theirs.length > 0
      ? {
          typeErrors: typeCheckText(
            {
              ok: false,
              reason: TypeCheckFailure.Errors,
              message: `${plural(theirs.length, "type error")} in your migrated files.`,
              diagnostics: [...theirs],
            },
            MIGRATION_TYPE_ERRORS_LIMIT,
          ),
        }
      : {}),
    ...(!types.ok && types.reason !== TypeCheckFailure.Errors ? { typeCheck: types.message } : {}),
  };
}

export class RecoveryService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;
  /** The layout migration this boot ran on the live workspace, until its live boot answers. */
  #migratedThisBoot: { key: string } | null = null;
  /** The seed report whose downgrade was already said (start() can run more than once per init). */
  #downgradeNoted: SeedUpgradeReport | null = null;

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  #seedManifestFile(): string {
    return path.join(this.#core.options.paths.userData, SEED_MANIFEST_FILE);
  }

  /** Where the shipped seed, the editable workspace and the manifest that tells them apart live. */
  #seedOptions(): ApplySeedOptions {
    return {
      seedDir: path.join(this.#core.options.paths.resources, "harness-seed"),
      workspaceDir: this.#core.layout.harnessWs,
      manifestFile: this.#seedManifestFile(),
      updatesDir: this.#core.layout.updates,
      ...(this.#core.options.appVersion ? { appVersion: this.#core.options.appVersion } : {}),
    };
  }

  #updatesBackupDir(prefix: string): string {
    return path.join(this.#core.layout.updates, `${prefix}-${Date.now().toString(36)}`);
  }

  /**
   * First launch seeds the editable self from the app bundle; every later launch *upgrades* it:
   * seed files the agent never touched track the app, files the agent edited are its own
   * (see seed-upgrade.ts — the old seed-once behaviour meant shipped fixes never reached an
   * existing install, and the workspace had to be deleted by hand twice on day one).
   */
  async seedHarnessWorkspace(): Promise<void> {
    const backupDir = this.#updatesBackupDir("seed-backup");
    this.#x.seedReport = await applySeed({ ...this.#seedOptions(), backupDir });
    await this.#core.snapshots.init();
  }

  /**
   * Keep the agent's memory in step with the seed's moves (seed-upgrade.ts SEED_MOVES): a kept
   * file that still defines code other harness files now import from its new home gets a note,
   * and a note that no longer holds is taken back. Every boot, since the agent may carry its edit
   * over at any time. A kept file that still calls the host the older way (SEED_CALL_CHANGES) gets
   * its own note. Needs the event store; a failure is logged, never fatal to the boot.
   */
  async noteSeedMoves(): Promise<void> {
    const report = this.#x.seedReport;
    if (!report) return;
    try {
      const memory = ((await this.#core.store.readArtifact<Record<string, unknown>>(this.#core.mainThread, "memory")) ??
        {}) as Record<string, unknown>;
      const next = seedCallMemory(seedMoveMemory(memory, report.moved ?? []), report.outdatedCalls ?? []);
      if (JSON.stringify(next) !== JSON.stringify(memory))
        await this.#core.store.writeArtifact(this.#core.mainThread, "memory", next);
    } catch (err) {
      this.#core.options.onLog?.(`[core] noting the seed's moved code failed: ${errorMessage(err)}`, "stderr");
    }
  }

  /**
   * Every death leaves a durable trace. A turn the process died inside has no `turn_ended`, so
   * the chat shows it thinking forever; a run killed with the app leaves `run_started`
   * unmatched, so the UI believes it is still running days later. Pending permission requests
   * also lose their in-memory waiter. Closing these here — before
   * the harness wakes — repairs logs written by any harness vintage: the stale live loop
   * benefits without waiting for a reseed. Closure only, never resumption: whether an
   * interrupted run restarts is the user's call, not a boot side effect.
   */
  async closeInterruptedWork(): Promise<void> {
    const finishedAt = new Date().toISOString();
    const inbox = inboxOf(this.#core.store);
    for (const thread of await this.#core.store.listThreads()) {
      // The log only grows, so the repair folds it from where the last launch stopped (see
      // REPAIR_FOLD): one read of what is new serves every repair below and the harness boot's
      // inbox restore after it. The closures appended here reach the next launch's fold.
      const { head, state } = await this.#core.store.foldThread(thread.id, REPAIR_FOLD);
      if (head) inbox.seed(thread.id, state.inbox, head);
      await this.#closeInterruptedTurns(thread.id, state);
      await this.#withdrawOpenQuestions(thread.id, state.questions);
      await this.#withdrawToolQuestions(thread.id, state.toolQuestions);
      for (const [runId, started] of new Map(state.runs))
        await this.#closeInterruptedRun(thread.id, runId, started, { finishedAt, workedUntil: state.lastAt });
    }
  }

  async #closeInterruptedTurns(threadId: string, state: RepairState): Promise<void> {
    if (state.turns.length === 0) return;
    // A message the queue was answering is retried once by the harness (message-queue.ts):
    // say so, rather than inviting a follow-up that would queue behind the replay.
    const notice = interruptedReplyNotice(state.inbox.records) ?? MESSAGE.replyInterrupted;
    for (const turnId of state.turns) {
      await this.#core.store.appendEvents(
        threadId,
        [
          { type: EventKind.TurnEnded, status: "error", metadata: { interrupted: true } },
          { type: EventKind.Error, message: notice },
        ],
        { turnId },
      );
    }
  }

  /**
   * No waiter survives a process restart. Persist the withdrawal so history and the
   * compact context agree; never replay the action or reinterpret it as user consent.
   */
  async #withdrawOpenQuestions(threadId: string, open: RepairState["questions"]): Promise<void> {
    const questions = [...new Map(open).values()];
    if (questions.length === 0) return;
    await this.#core.store.appendEvents(
      threadId,
      questions.map((question) =>
        customEventData(CustomEvent.PluginConsent, {
          ...question,
          state: "declined",
          by: "restart",
        } satisfies PluginConsentEvent),
      ),
    );
  }

  /** Claude's unanswered tool permissions, the same way: denied by the restart, never allowed. */
  async #withdrawToolQuestions(threadId: string, open: RepairState["toolQuestions"]): Promise<void> {
    const questions = [...new Map(open).values()];
    if (questions.length === 0) return;
    await this.#core.store.appendEvents(
      threadId,
      questions.map((question) =>
        customEventData(CustomEvent.ToolPermission, {
          ...question,
          state: ToolPermissionState.Denied,
          by: ToolPermissionBy.Restart,
        } satisfies ToolPermissionEvent),
      ),
    );
  }

  /**
   * An interrupted unattended run with a live journal is paused, not dead: the closure
   * still lands (nothing may read as "still running"), and the paused card + journal
   * phase make the one-click Resume possible. Boot never redispatches (the doctrine
   * above holds) — resuming is the user's click.
   *
   * The gate is the journal artifact, never the `mode` field: a director's run writes
   * `run_registered {mode:"autopilot"}` and then `run_started {mode:"director"}`, so a
   * mode gate paused the classic pipeline and quietly buried every director run —
   * closed as "interrupted by restart" with no Resume, no head and no build card, while
   * its merges sat on a ref nobody was shown.
   */
  async #closeInterruptedRun(
    threadId: string,
    runId: string,
    started: RunWords,
    { finishedAt, workedUntil }: { finishedAt: string; workedUntil: string | undefined },
  ): Promise<void> {
    const journal = ((await this.#core.store.readArtifact(threadId, journalArtifact(runId)).catch(() => null)) ??
      null) as RunJournal | null;
    if (journal) await this.#closeInterruptedOptimization(threadId, runId, journal, finishedAt);
    const paused = journal !== null && journal.phase !== "done";
    const landing = paused ? await this.#pauseLoopRun(threadId, runId, journal) : null;
    await this.#core.store.appendEvents(threadId, [
      customEventData(CustomEvent.RunFinished, {
        runId,
        ...started,
        victory: false,
        stoppedBecause: MESSAGE.runInterrupted,
        finishedAt,
        // The repair writes this close (and maybe its own records before it) at the next launch:
        // the run's work ended with the conversation's last record, not now (run-state.ts).
        ...(workedUntil ? { workedUntil } : {}),
        ...(landing ?? {}),
      }),
      ...(paused ? [customEventData(CustomEvent.AutopilotPaused, { runId, ...started })] : []),
    ]);
  }

  async #pauseLoopRun(threadId: string, runId: string, journal: RunJournal): Promise<LoopRunLanding | null> {
    await this.#core.store
      .writeArtifact(threadId, journalArtifact(runId), { ...journal, phase: "paused" })
      .catch(() => {});
    return loopRunLanding(runId, journal);
  }

  /** An Optimization stage the app died inside ends as interrupted, with its budget charged. */
  async #closeInterruptedOptimization(
    threadId: string,
    runId: string,
    journal: RunJournal,
    finishedAt: string,
  ): Promise<void> {
    const cp = journal.optimization;
    if (!optimizationLeftOpen(cp)) return;
    const result = cp.result;
    chargeInterruptedSegment(cp, Date.now());
    result.outcome = "interrupted";
    result.reasonCode = "restart";
    result.reason = MESSAGE.optimizationInterrupted;
    result.summary = MESSAGE.optimizationNotApplied;
    await this.#recoverAdoption(cp, result);
    result.phase = "terminal";
    result.finishedAt = finishedAt;
    result.sequence++;
    cp.phase = "interrupted";
    await this.#core.saveRunArtifact(runId, "optimization/result.json", Buffer.from(JSON.stringify(result)));
    await this.#core.saveRunArtifact(runId, "optimization/checkpoint.json", Buffer.from(JSON.stringify(cp)));
    await this.#core.store.writeArtifact(threadId, journalArtifact(runId), journal);
    await this.#core.store.appendEvents(threadId, [customEventData(CustomEvent.OptimizationUpdated, { ...result })]);
  }

  /** An adoption the app died inside: what the game folder now holds decides how it ended. */
  async #recoverAdoption(cp: OptimizationCheckpointV1, result: OptimizationResultV1): Promise<void> {
    if (!cp.adoptionIntent || !cp.baseline) return;
    const recovered = await this.#core.candidates
      .reconcile(cp.project, cp.baseline.revision, cp.adoptionIntent.verifiedCandidate)
      .catch(() => null);
    if (!recovered) return;
    result.retainedRevision = recovered.revision;
    result.candidateAdopted = recovered.retained === RetainedState.Candidate;
    if (result.candidateAdopted) {
      result.outcome = "improved";
      result.summary = MESSAGE.adoptionRecovered;
      return;
    }
    if (recovered.retained === RetainedState.Changed) result.summary = MESSAGE.liveFilesChanged;
  }

  async rebuildSnapshotIndex(): Promise<void> {
    const { state } = await this.#core.store.foldThread(this.#core.mainThread, SNAPSHOT_FOLD);
    for (const event of state) this.#x.indexEvent(event);
  }

  /**
   * R3: the harness commit a boot is about to run, or null when code files differ from it (what
   * boots is then not what any snapshot holds).
   */
  async codeAboutToBoot(): Promise<string | null> {
    try {
      const dirty = await this.#core.snapshots.uncommittedPaths(HARNESS_WORKSPACE);
      if (dirty.some((file) => RUNS_AS_CODE.test(file))) return null;
      return await this.#core.snapshots.currentCommit(HARNESS_WORKSPACE);
    } catch {
      return null;
    }
  }

  /**
   * R3: a self that booted and answered its healthcheck has run, whoever wrote it. The snapshot
   * holding exactly that commit becomes healthy, so code a self-edit wrote without
   * restart_studio (a new tool) does not stay unhealthy for good and hold back every later
   * skill edit measured against it. Only an app-initiated boot vouches: a crash restart is
   * evidence of the opposite.
   */
  vouchForBootedSelf(commit: string): void {
    const record = this.#core.snapshotIndex.all().findLast((candidate) => candidate.git.harness === commit);
    if (!record) return;
    if (!record.healthy || record.harness_healthy === false) this.markHealthy(record.snapshot_id);
  }

  markHealthy(snapshotId: string): void {
    this.#core.snapshotIndex.markHealthy(snapshotId);
    void this.#core.append([customEventData(CustomEvent.SnapshotHealthy, { snapshot_id: snapshotId })]);
  }

  /**
   * The loop died — it crashed, or the watchdog is about to rewind it. Everything it briefed is
   * now unsupervised: a contractor keeps editing its worktree with nobody left to judge, commit or
   * land the round, and the run reads as running until the next app boot. So every delegation is
   * aborted — none of them can be judged or committed without the loop, whatever the cwd — and
   * every run that was holding the Mac awake is settled here, which frees the power blocker, the
   * quit gate and the idle watch. The *cards* are not written here: a run's ending belongs to the
   * harness's own contract, so the ids are carried into the next boot notice instead and the
   * reborn loop closes each one in its own thread.
   *
   * Plugins are not the loop's: their backends, accounts and connectors stay up for the reborn
   * loop. Only the plugin and connector calls in flight end, first, so each is recorded as cut off
   * by the harness's end (outcome unknown) before a delegation's own abort could end it as a stop.
   */
  async onHarnessDied(): Promise<{ openRuns: string[] }> {
    this.#core.plugins?.abortCalls(CallCutOff.HarnessEnded);
    for (const controller of this.#x.activeConnectorCalls.keys())
      controller.abort(new PluginCallCutOff(CallCutOff.HarnessEnded));
    // Its workers writing in place let go below (`releaseHarnessLeases`); its calls waiting for a
    // lock leave the line as their aborts reach them. The host's own holds (a restore, the
    // person's Rewind) end with their own work, which goes on in main.
    this.#x.consent.cancel({}, "stop");
    this.#x.permissions.cancel({}, ToolPermissionBy.Stop);
    for (const release of this.#x.pluginTurnLeases.values()) await release();
    this.#x.pluginTurnLeases.clear();
    for (const delegation of this.#x.activeDelegations.values()) delegation.abort.abort();
    // The map is deliberately left alone: each delegation's own `finally` removes its entry and
    // releases its window lease when the engine actually lets go, and until then Stop must still
    // be able to find a contractor that shrugged off the first signal.
    // Direct completions are the same story one layer down — every one of them was asked for by
    // the loop that is gone, so a local model would generate for minutes into nobody's hands.
    for (const set of this.#x.activeCompletions.values()) for (const controller of set) controller.abort();
    // Their turns will never end: the loop that began them is gone.
    this.#x.openTurns.clear();
    for (const runId of this.#x.activeRunIds) {
      this.#x.runsOrphanedByCrash.add(runId);
      this.#core.emit(UiEvent.RunSettled, { runId });
    }
    this.#x.activeRunIds.clear();
    await this.releaseHarnessLeases();
    return { openRuns: [...this.#x.runsOrphanedByCrash] };
  }

  /**
   * Give back every preview window the ending harness boot borrowed over RPC, and the locks it held
   * for its workers writing in place — its own `finally` blocks will never run. Windows the host
   * holds for a delegation or a build carry no owner and are left to their own release.
   */
  async releaseHarnessLeases(): Promise<void> {
    // Its workers writing in place are gone with it, a planned restart's as much as a crash's.
    this.#x.locks.releaseHarnessHolds();
    const owner = `harness:${this.#x.harnessBoot++}`;
    const released = (await this.#x.previewPool?.releaseOwnedBy(owner).catch(() => [] as string[])) ?? [];
    for (const handle of released) this.#x.profileSources.delete(handle);
  }

  // ── recovery (watchdog) ──────────────────────────────────────────────────────────────────
  /**
   * The watchdog. Rewind to the newest snapshot that is *known to have run*, restart, and
   * write what happened into the log so the morning report can show it.
   */
  async recover(reason: string): Promise<void> {
    if (this.#x.recovering) return;
    this.#x.recovering = true;
    let openRuns: string[] = [];
    let target: SnapshotRecord | undefined;
    try {
      // A rewind is the end of the loop that was supervising this run's work, whether it died on
      // its own or is being restarted under it. Same duty as a crash, so: same call.
      ({ openRuns } = await this.onHarnessDied());
      target = this.#core.snapshotIndex.newestHealthy(SnapshotScope.Harness);
      this.#core.emit(UiEvent.WatchdogTriggered, { reason, snapshot: target?.snapshot_id ?? null });
      await this.#core.append([{ type: EventKind.Error, message: `watchdog: ${reason}` }]);
      await this.#rewindHarness(reason, target);
      await this.#bootRecoveredSelf(reason, openRuns, { snapshotId: target?.snapshot_id });
    } catch (err) {
      await this.#reseedAfterFailedRewind(reason, err, target, openRuns);
    } finally {
      this.#x.recovering = false;
    }
  }

  async #rewindHarness(reason: string, target: SnapshotRecord | undefined): Promise<void> {
    if (!target) {
      // Nothing healthy yet (first minutes of a fresh install): fall back to the shipped self.
      await this.reseedFromApp();
      await this.#core.append([customEventData(CustomEvent.HarnessReseeded, { reason })]);
      return;
    }
    await this.keepingGameLessons(() => this.#core.snapshots.restore(target));
    await this.#core.reconcileSeedManifest();
    await this.#core.append([
      { type: EventKind.WorkspaceRestored, snapshot_id: target.snapshot_id, reason, scope: SnapshotScope.Harness },
    ]);
  }

  /** Boot the rewound (or reseeded) self and say whether it answered. */
  async #bootRecoveredSelf(
    reason: string,
    openRuns: readonly string[],
    rewind: { snapshotId?: string | undefined; reseeded?: true },
  ): Promise<void> {
    this.#core.host.clearExits();
    // This call owns the boot it asks for: a failure lands in the caller's catch, not in a
    // background crash restart of the same self.
    await this.#core.host.restart(
      {
        type: DispatchActionType.BootNotice,
        notice: {
          reason: BootReason.WatchdogRestore,
          detail: reason,
          ...(rewind.snapshotId ? { snapshotId: rewind.snapshotId } : {}),
          ...(openRuns.length ? { openRuns: [...openRuns] } : {}),
        },
      },
      { callerRecovers: true },
    );
    // Told once is enough: the reborn loop has the ids, and closing a run is idempotent.
    this.#x.runsOrphanedByCrash.clear();
    const healthy = await this.#core.host.healthcheck();
    this.#core.emit(UiEvent.WatchdogRecovered, { reason, ok: healthy, ...(rewind.reseeded ? { reseeded: true } : {}) });
  }

  /**
   * ARCH-6: the rewind itself failed (a stale git lock, a damaged snapshot repository, a
   * "healthy" self that does not boot). The shipped seed is the last resort before a human.
   */
  async #reseedAfterFailedRewind(
    reason: string,
    err: unknown,
    target: SnapshotRecord | undefined,
    openRuns: readonly string[],
  ): Promise<void> {
    const failed = errorMessage(err);
    try {
      if (!target) throw err;
      await this.#core.host.stop().catch(() => {});
      await this.reseedFromApp();
      await this.#core.append([
        customEventData(CustomEvent.HarnessReseeded, { reason, after: MESSAGE.rewindFailed(failed) }),
      ]);
      await this.#bootRecoveredSelf(reason, openRuns, { reseeded: true });
    } catch (last) {
      const message = last === err ? failed : MESSAGE.reseedFailedToo(failed, errorMessage(last));
      this.#core.emit(UiEvent.WatchdogFailed, { reason, error: message });
      await this.#core.append([{ type: EventKind.Error, message: MESSAGE.watchdogFailed(message) }]);
    }
  }

  /**
   * What the runs learned about each game (`library/games`, the ledger and its lessons) is
   * history, not a self-change: rewinding the harness's code must not take it back. It is set
   * aside before a restore and put back after, newer files winning.
   */
  async keepingGameLessons<T>(restore: () => Promise<T>): Promise<T> {
    const dir = path.join(this.#core.layout.harnessWs, "library", "games");
    const aside = path.join(this.#core.layout.scratch, "game-lessons", shortId("keep"));
    const kept = await cp(dir, aside, { recursive: true }).then(
      () => true,
      () => false,
    );
    try {
      return await restore();
    } finally {
      if (kept) {
        await cp(aside, dir, { recursive: true, force: true }).catch((err: Error) =>
          this.#core.options.onLog?.(
            `[core] could not put the game lessons back after a restore: ${err.message}`,
            "stderr",
          ),
        );
        await rm(aside, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * The user's own rewind to a saved version (the chat's Rewind). It restarts the harness, so
   * it waits for work in flight instead of cutting a build off without closing it.
   */
  async rollbackTo(snapshotId: string): Promise<void> {
    const record = this.#core.snapshotIndex.get(snapshotId);
    if (!record) throw new Error(MESSAGE.snapshotGone);
    if (this.#x.selfImprovement.workInFlight()) throw new Error(MESSAGE.buildInFlight);
    const rescue = await this.keepingGameLessons(() => this.#core.snapshots.restore(record));
    // A manual rollback rewinds the harness exactly like the watchdog does — skipping the
    // reconcile here would pin every rewound seed file as an agent edit at the next boot.
    if (record.scope !== SnapshotScope.Game) await this.#core.reconcileSeedManifest();
    await this.#core.append([
      ...(rescue ? [this.snapshotCreated(rescue)] : []),
      {
        type: EventKind.WorkspaceRestored,
        snapshot_id: snapshotId,
        reason: "manual rollback",
        scope: record.scope,
        ...(rescue ? { rescue_snapshot_id: rescue.snapshot_id } : {}),
      },
    ]);
    await this.releaseHarnessLeases();
    await this.#core.host.restart({
      type: DispatchActionType.BootNotice,
      notice: { reason: BootReason.WatchdogRestore, snapshotId, detail: MESSAGE.rolledBackByUser },
    });
  }

  /**
   * A harness restore moves seed files back in time without touching the manifest, and the
   * boot-time ownership rule would then read every rewound file as an agent edit and pin it
   * forever, and after a few watchdog rewinds no shipped fix could land. Re-owning is delegated to seed-upgrade.ts, which owns the manifest's semantics;
   * a failure is logged and swallowed — bookkeeping must never abort a recovery. Public
   * because every path that rewinds the harness owes this call — the user's manual rollback
   * (main/index.ts) included, not just the watchdog and the agent's own restores.
   */
  async reconcileSeedManifest(): Promise<void> {
    try {
      const { seedDir, workspaceDir, manifestFile, updatesDir } = this.#seedOptions();
      const { reconciled } = await reconcileManifestWithSeedVintages({
        workspaceDir,
        manifestFile,
        seedDir,
        updatesDir,
      });
      if (reconciled.length > 0) {
        await this.#core.append([customEventData(CustomEvent.SeedManifestReconciled, { files: reconciled })]);
      }
    } catch (err) {
      this.#core.options.onLog?.(`[core] seed manifest reconcile failed: ${errorMessage(err)}`, "stderr");
    }
  }

  /**
   * The one-time move of an existing workspace from the JavaScript layout (`loop/*.mjs`) to the
   * TypeScript one (seed-upgrade.ts `migrateHarnessLayout`). The boot's seed upgrade held the new
   * `.ts` modules back; here, before the harness boots:
   *
   *  1. a snapshot of the workspace as it is. It is a rewind target only by the usual rules — its
   *     code is exactly an already-healthy snapshot's (inheritHealth), or it boots below — never
   *     by being taken here: the self it holds may be a last-session edit that never ran;
   *  2. the migration runs in a validation fork of that snapshot, which is type-checked — errors in
   *     the agent's migrated files are reported, never blocking — and booted;
   *  3. only a fork that answered its healthcheck lets the same migration run on the live
   *     workspace, which is then snapshotted. That snapshot too becomes healthy when the live boot
   *     that follows answers (StudioCore.start vouches for the code it booted): a migrated self
   *     that booted in its fork but not live is no rewind target, and the rewind goes back past it
   *     to the JavaScript tree (`migratedSelfDidNotBoot`).
   *
   * A fork that does not boot leaves the workspace on its JavaScript tree, which the bootstrap
   * still boots (`loop/main.mjs`), says so in Studio activity, and is retried once the seed or the
   * agent's modules change. Never fatal: a boot matters more than a migration.
   */
  async migrateHarnessLayout(): Promise<void> {
    this.#migratedThisBoot = null;
    const done = await this.#migrateLayout();
    // An older build of the app ran the workspace since the last update (seed-upgrade.ts
    // `downgraded`): whatever the agent edited in the JavaScript files that build laid down is
    // backed up beside TypeScript files that win, and would otherwise vanish without a word.
    const report = this.#x.seedReport;
    if (!report?.downgraded || this.#downgradeNoted === report) return;
    this.#downgradeNoted = report;
    const stranded = done?.stranded ?? [];
    await this.#core
      .append([
        customEventData(CustomEvent.HarnessDowngraded, {
          ...(stranded.length > 0 ? { stranded } : {}),
          migrated: done !== null,
        }),
      ])
      .catch(() => {});
  }

  async #migrateLayout(): Promise<LayoutMigrationReport | null> {
    const options = this.#seedOptions();
    const pending = await layoutMigrationPending(options).catch(() => null);
    if (!pending?.retry) return null;
    try {
      await this.inheritHealth(await this.#core.snapshot(SnapshotScope.Harness, "before harness layout migration"));
      const trial = await this.#trialLayoutMigration(options);
      if (!trial.booted.ok) {
        await recordLayoutAttempt(options.manifestFile, pending.key, trial.booted.message);
        await this.#core.append([
          customEventData(CustomEvent.HarnessLayoutMigrated, {
            ok: false,
            error: `the migrated copy did not start: ${trial.booted.message}`,
            renamed: trial.tried.renamed,
          }),
        ]);
        return null;
      }
      const done = await migrateHarnessLayout({ ...options, backupDir: this.#updatesBackupDir("seed-backup") });
      await this.#core.snapshot(SnapshotScope.Harness, "after harness layout migration");
      this.#migratedThisBoot = { key: pending.key };
      const theirs = this.#agentTypeErrors(done, trial.types);
      await this.#core.append([
        customEventData(CustomEvent.HarnessLayoutMigrated, layoutMigratedPayload(done, trial.types, theirs)),
      ]);
      await this.#noteLayoutInMemory(layoutMemoryNote(done, theirs));
      return done;
    } catch (err) {
      this.#core.options.onLog?.(`[core] harness layout migration failed: ${errorMessage(err)}`, "stderr");
      await recordLayoutAttempt(options.manifestFile, pending.key, errorMessage(err)).catch(() => {});
      await this.#core
        .append([customEventData(CustomEvent.HarnessLayoutMigrated, { ok: false, error: errorMessage(err) })])
        .catch(() => {});
      return null;
    }
  }

  /** The migration in a validation fork of the workspace: what it did, what the compiler said, whether it booted. */
  async #trialLayoutMigration(
    options: ApplySeedOptions,
  ): Promise<{ tried: LayoutMigrationReport; types: TypeCheckResult; booted: ForkBoot }> {
    const gate = this.#x.selfEditGate;
    const trial = path.join(this.#core.layout.scratch, "layout-migration", shortId("trial"));
    const fork = path.join(trial, "fork");
    try {
      await gate.openFork(fork);
      await cp(options.manifestFile, path.join(trial, "manifest.json"));
      const tried = await migrateHarnessLayout({
        ...options,
        workspaceDir: fork,
        manifestFile: path.join(trial, "manifest.json"),
        backupDir: path.join(trial, "seed-backup-trial"),
      });
      const types = await gate.typecheck(fork);
      const booted = await gate.boot(fork);
      return { tried, types, booted };
    } finally {
      await gate.closeFork(fork);
      await rm(trial, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Errors in what the agent wrote are its to fix, and never block the boot; anything else
   * the compiler said is the seed's, and goes to the log.
   */
  #agentTypeErrors(done: LayoutMigrationReport, types: TypeCheckResult): string[] {
    if (types.ok) return [];
    const agentFiles = [...done.renamed, ...done.rewritten.filter((rel) => rel.endsWith(".ts"))];
    const theirs = diagnosticsFor(types.diagnostics, agentFiles);
    if (theirs.length < types.diagnostics.length)
      this.#core.options.onLog?.(
        `[core] the migrated harness type check: ${typeCheckText(types, { maxLines: MIGRATION_LOG_MAX_LINES })}`,
        "stderr",
      );
    return theirs;
  }

  /**
   * The agent reads its memory in every prompt, and no Studio record: this is how it hears
   * that its own files now have type errors to fix, or that an edit of its no longer runs
   * (the agent's to forget once it has).
   */
  async #noteLayoutInMemory(note: string | null): Promise<void> {
    if (!note) return;
    const memory = ((await this.#core.store
      .readArtifact<Record<string, unknown>>(this.#core.mainThread, "memory")
      .catch(() => null)) ?? {}) as Record<string, unknown>;
    const kept = note.length > MEMORY_NOTE_MAX_CHARS ? `${note.slice(0, MEMORY_NOTE_MAX_CHARS - 1)}…` : note;
    await this.#core.store
      .writeArtifact(this.#core.mainThread, "memory", { ...memory, [LAYOUT_MEMORY_KEY]: kept })
      .catch(() => {});
  }

  /**
   * The live boot right after a layout migration failed, though the migrated fork booted. The
   * migrated snapshot was never vouched for, so the rewind that follows lands on the JavaScript
   * tree (or an older healthy self) rather than on the self that just failed; the attempt is
   * recorded so the next launch does not migrate into the same failure, and Studio activity says so.
   */
  async migratedSelfDidNotBoot(error: string): Promise<void> {
    const migrated = this.#migratedThisBoot;
    this.#migratedThisBoot = null;
    if (!migrated) return;
    const message = `the migrated self did not start: ${error}`;
    await recordLayoutAttempt(this.#seedManifestFile(), migrated.key, message).catch(() => {});
    await this.#core
      .append([customEventData(CustomEvent.HarnessLayoutMigrated, { ok: false, error: message })])
      .catch(() => {});
  }

  async reseedFromApp(): Promise<void> {
    const options = this.#seedOptions();
    // The shipped self is TypeScript: the JavaScript modules it replaced go (backed up, since they
    // may hold the agent's edits), or an edited one would be migrated over the fresh copy next boot.
    await removeLegacyModules({
      seedDir: options.seedDir,
      workspaceDir: options.workspaceDir,
      backupDir: this.#updatesBackupDir("reseed-backup"),
    });
    for (const entry of await readdir(options.seedDir)) {
      await cp(path.join(options.seedDir, entry), path.join(options.workspaceDir, entry), {
        recursive: true,
        force: true,
      });
    }
    // The workspace now matches the seed again — the manifest must say so, or the next boot
    // would mistake this recovery for a pile of agent edits and pin them forever.
    await applySeed(options);
  }

  async snapshot(
    scope: SnapshotScope,
    reason: string,
    project?: string,
    healthy?: boolean,
    options: { harnessHealthy?: false } = {},
  ): Promise<SnapshotRecord> {
    if (project) {
      await this.#core.assertProjectAllowed(this.#core.games.dirFor(project));
      this.#core.snapshots.register({ name: project, dir: this.#core.games.dirFor(project) });
      await this.#core.snapshots.init();
    }
    const record = await this.#core.snapshots.snapshot({
      scope,
      reason,
      ...(project ? { gameWorkspace: project } : {}),
      ...(healthy !== undefined ? { healthy } : {}),
    });
    if (options.harnessHealthy === false && record.git.harness) record.harness_healthy = false;
    await this.#core.append([this.snapshotCreated(record)]);
    return record;
  }

  snapshotCreated(record: SnapshotRecord): EventData {
    return {
      type: EventKind.SnapshotCreated,
      snapshot_id: record.snapshot_id,
      scope: record.scope,
      git: record.git,
      healthy: record.healthy,
      ...(record.harness_healthy === false ? { harness_healthy: false as const } : {}),
      reason: record.reason,
    };
  }

  /**
   * The guardian flow: durable record first, snapshot second, reply third, and
   * only then — after the current turn has had a moment to finish — the actual restart.
   */
  async requestSelfRestart(
    reason: string,
    graceMs = SELF_RESTART_GRACE_MS,
  ): Promise<{ updateId: string; snapshotId: string }> {
    const snapshot = await this.#core.snapshot(SnapshotScope.Harness, `self-update: ${reason}`);
    const record = await this.#core.journal.queue(reason, snapshot.snapshot_id);
    this.#x.pendingUpdateId = record.id;
    this.#core.emit(UiEvent.SelfmodRestartQueued, { updateId: record.id, reason, snapshotId: snapshot.snapshot_id });

    setTimeout(() => {
      void this.applySelfRestart(record.id, reason, snapshot.snapshot_id);
    }, graceMs);

    return { updateId: record.id, snapshotId: snapshot.snapshot_id };
  }

  async applySelfRestart(updateId: string, reason: string, snapshotId: string): Promise<void> {
    try {
      await this.releaseHarnessLeases();
      // A self that does not boot is rewound by the catch below, not raced by a crash restart.
      await this.#core.host.restart(
        { type: DispatchActionType.BootNotice, notice: { reason: BootReason.SelfUpdate, updateId, detail: reason } },
        { callerRecovers: true },
      );
      const ok = await this.#core.host.healthcheck();
      await this.#core.journal.complete(
        updateId,
        ok ? "applied" : "failed",
        ok ? undefined : MESSAGE.healthcheckFailed,
      );
      await this.#core.append([
        customEventData(CustomEvent.RebuildAndRestartStudio, { updateId, ok, reason, snapshotId }),
      ]);
      if (ok) this.markHealthy(snapshotId);
      else await this.#core.recover(MESSAGE.selfUpdateUnhealthy(updateId));
      this.#core.emit(UiEvent.SelfmodRestarted, { updateId, ok });
    } catch (err) {
      await this.#core.journal.complete(updateId, "failed", errorMessage(err));
      await this.#core.recover(MESSAGE.selfUpdateThrew(updateId, errorMessage(err)));
    } finally {
      this.#x.pendingUpdateId = null;
    }
  }

  /**
   * A snapshot that differs from the newest healthy one only in files the harness reads but
   * never runs (skills, prompts, the library) is exactly as healthy, and becomes the point a
   * rewind returns to — otherwise the first wedge after an approval quietly took it back.
   */
  async inheritHealth(record: SnapshotRecord): Promise<void> {
    const healthy = this.#core.snapshotIndex.newestHealthy(SnapshotScope.Harness);
    if (!healthy?.git.harness || !record.git.harness) return;
    const changed = await this.#core.snapshots
      .changedPaths(HARNESS_WORKSPACE, healthy.git.harness, record.git.harness)
      .catch(() => null);
    if (changed && !changed.some((file) => RUNS_AS_CODE.test(file))) this.markHealthy(record.snapshot_id);
  }
}
