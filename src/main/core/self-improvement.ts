/**
 * Self-improvement: staged SkillOpt proposals (applied automatically or by the user), the idle-time
 * architect, and the studio's own changes listed and undone. Composed by `StudioCore`; its state
 * stays in the core.
 */
import path from "node:path";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { StagedTarget } from "../../shared/self-change-files.ts";
import { undoneSelfChanges } from "../../shared/run-review.ts";
import {
  RUNS_AS_CODE,
  SuggestionRefused,
  changeRecords,
  findStaged,
  proposalTarget,
  rebaseProposal,
  type ChangeRecord,
  type StagedRecord,
} from "../self-changes.ts";
import type { SnapshotRecord } from "../../substrate/snapshots.ts";
import { typeCheckText } from "../../substrate/type-gate.ts";
import type { CompleteRequest, CompleteResponse, Engine } from "../../substrate/engines/types.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { SUBSCRIPTION_ENGINES } from "./subscription-engines.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { WorkClass } from "../../shared/harness-api.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";
import { BootReason, DispatchActionType } from "../../shared/protocol.ts";
import { EngineId } from "../../shared/providers.ts";
import { architectPickPrompt, architectRewritePrompt } from "./self-improvement-prompts.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { ImprovementStatus } from "../../substrate/improvement-journal.ts";
import { SnapshotScope } from "../../shared/event-log.ts";
import { samePath, toPosixRelative } from "../../substrate/paths.ts";
import { readRegularFile, realpathNearest, writeFileNoFollow } from "../../substrate/fsx.ts";

/** How often the idle watch looks for a quiet stretch, unless the options say otherwise. */
const ARCHITECT_CHECK_MS = MINUTE_MS;
/** The fastest the idle watch may tick, whatever the options say. */
const ARCHITECT_MIN_CHECK_MS = 250;
/** How long the studio must sit untouched before the architect looks. */
const ARCHITECT_IDLE_MS = 10 * MINUTE_MS;
/** The least time between two architect passes. */
const ARCHITECT_MIN_GAP_MS = 6 * HOUR_MS;
/** How long the architect may take to pick a file. */
const ARCHITECT_PICK_TIMEOUT_MS = 5 * MINUTE_MS;
/** How long the architect may take to rewrite it. */
const ARCHITECT_REWRITE_TIMEOUT_MS = 10 * MINUTE_MS;
/** How many recent lessons the pick call sees. */
const ARCHITECT_LESSONS_SHOWN = 10;
/** The largest file the architect may rewrite, in characters. */
const ARCHITECT_MAX_FILE_CHARS = 64_000;
/** How deep below the workspace the architect's file list reaches. */
const ARCHITECT_MAX_DEPTH = 3;
/** How much of a rewrite's type errors its failure note carries. */
const ARCHITECT_TYPE_ERRORS_LIMIT = { maxLines: 10, maxChars: 1_500 } as const;
/** How many entries the analyst's step buffer keeps. */
const STEP_BUFFER_MAX_ENTRIES = 50;
/** The largest instructions file a suggestion may be applied to, in bytes. */
const SUGGESTION_FILE_MAX_BYTES = 1024 * 1024;
/** What `mkdir` says when a file or a link already stands where a suggestion's folder should be. */
const FOLDER_TAKEN: ReadonlySet<string> = new Set(["EEXIST", "ENOTDIR"]);
/** The longest diff Activity shows for one change, in characters. */
const CHANGE_DIFF_MAX_CHARS = 400_000;

/** Words the user reads when a suggestion or an undo cannot go ahead. */
const MESSAGE = {
  suggestionGone: "This suggestion is no longer waiting. Harness may have applied or discarded it already.",
  suggestionTargetGone: "The instructions this suggestion changes are gone. Discard it.",
  suggestionOutside:
    "This suggestion’s file is not a plain file in Harness’s instructions, so Studio did not apply it. Discard it.",
  changeNotFound: "Harness couldn’t find this change.",
  changeAlreadyUndone: "This change was already undone.",
  changeBaseGone: "Harness no longer has the version from before this change, so it can’t undo it.",
  undoWhileBuilding: "Harness is building right now. Undo this change when the build finishes.",
  undoConflict: "A later change edited the same part of Harness’s instructions. Undo that change first.",
  changeAlreadyGone: "This change no longer differs from what Harness has now.",
} as const;

/** Folders the architect never sees: the frozen judge, and installed packages. */
const HIDDEN_FROM_ARCHITECT: ReadonlySet<string> = new Set(["node_modules", "judge"]);
const ARCHITECT_FILE = /\.(ts|mjs|md)$/;

const hiddenFromArchitect = (name: string): boolean => name.startsWith(".") || HIDDEN_FROM_ARCHITECT.has(name);
const architectMayEdit = (name: string): boolean => ARCHITECT_FILE.test(name) && !name.endsWith(".d.ts");

/** An engine the architect can ask for a completion. */
interface ArchitectEngine {
  id: string;
  complete: NonNullable<Engine["complete"]>;
}

/** Why an architect step stops the job, as its journal note. */
interface Refusal {
  refused: string;
}

/** The file the architect chose to change, and why. */
interface ArchitectPick {
  relative: string;
  why: string | undefined;
}

/** The architect's rewrite of the file it picked. */
interface ArchitectRewrite {
  target: string;
  reason: string;
  contents: string;
}

/** A rewrite tried in a fork: type errors it added (code only), or whether the fork booted. */
interface ForkVerdict {
  healthy: boolean;
  typeErrors: string | null;
}

/** Collect the files below `dir` the architect may edit, relative to the workspace. */
async function collectArchitectFiles(workspace: string, dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > ARCHITECT_MAX_DEPTH) return;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (hiddenFromArchitect(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) {
      if (architectMayEdit(entry.name)) out.push(toPosixRelative(path.relative(workspace, full)));
      continue;
    }
    // library/games/*.md is the run ledger's derived output (loop/ledger.ts): the studio
    // rewrites it at every close, so an architect edit there is gone by morning.
    if (path.relative(workspace, full) === path.join("library", "games")) continue;
    await collectArchitectFiles(workspace, full, depth + 1, out);
  }
}

const isRefusal = (value: object): value is Refusal => "refused" in value;

/** The error a write through a planted link gets (`O_NOFOLLOW`), or a dangling link on the way. */
const isLinkRefusal = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === "ELOOP";

/**
 * Refuse unless `folder` is a real folder exactly where its spelling says: no link at it, and none
 * on the way to it.
 */
async function assertRealFolder(folder: string): Promise<void> {
  const [info, real] = await Promise.all([lstat(folder).catch(() => null), realpath(folder).catch(() => null)]);
  const plain = info?.isDirectory() === true && real !== null && samePath(real, folder);
  if (!plain) throw new SuggestionRefused(MESSAGE.suggestionOutside);
}

/**
 * Where a suggestion's workspace-relative `file` lands: under the workspace's real path, in a
 * folder that is no link and leads nowhere else, created when it is missing. A link the harness
 * planted on the way (dangling, to an outside folder, or to another folder of the workspace) or a
 * file where the folder should be refuses the suggestion before anything is created or written.
 */
async function suggestionFile(harnessWs: string, file: string): Promise<string> {
  const target = path.join(await realpath(harnessWs), file);
  const folder = path.dirname(target);
  const planned = await realpathNearest(folder).catch(() => null);
  if (planned === null || !samePath(planned, folder)) throw new SuggestionRefused(MESSAGE.suggestionOutside);
  // Something else standing where the folder should be is refused just below; a passing failure
  // (a full disk) is no refusal, and the suggestion waits for the next try.
  await mkdir(folder, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
    if (!FOLDER_TAKEN.has(err.code ?? "")) throw err;
  });
  await assertRealFolder(folder);
  return target;
}

/**
 * A suggestion's file as it reads now, never through a link: `missing` when there is none, and a
 * refusal for a link, a folder, a device or anything too large to be instructions.
 */
async function readSuggestionFile(file: string, missing: string | null): Promise<string | null> {
  try {
    return (await readRegularFile(file, SUGGESTION_FILE_MAX_BYTES)).toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return missing;
    throw new SuggestionRefused(MESSAGE.suggestionOutside);
  }
}

/**
 * Write a suggestion's text, its folder checked again just before (the harness runs meanwhile)
 * and never through a link planted at the file's own name.
 */
async function writeSuggestionFile(file: string, text: string): Promise<void> {
  await assertRealFolder(path.dirname(file));
  try {
    await writeFileNoFollow(file, text);
  } catch (err) {
    if (isLinkRefusal(err)) throw new SuggestionRefused(MESSAGE.suggestionOutside);
    throw err;
  }
}

const CHANGE_DIFFS_KEPT = 32;

export class SelfImprovementService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  #backgroundImprovementOff(): boolean {
    return this.#core.options.executionPolicy?.runBackgroundImprovement === false || !this.#x.settings.learning;
  }

  async autoApplyStaged(): Promise<void> {
    if (this.#backgroundImprovementOff() || this.#x.autoApplying) return;
    this.#x.autoApplying = true;
    try {
      // By identity, oldest first. A suggestion that no longer fits its file is taken off the
      // list rather than retried at the head of it forever, blocking every one behind it.
      const tried = new Set<string>();
      for (;;) {
        const staged = await this.stagedList();
        const index = staged.findIndex((p) => !tried.has(`${p.at}\u0000${p.skill}`));
        const next = staged[index];
        if (!next) break;
        tried.add(`${next.at}\u0000${next.skill}`);
        const key = next.at ? { at: next.at, skill: next.skill } : undefined;
        try {
          const { skill } = await this.#core.acceptStagedProposal(index, "auto", key);
          this.#core.emit(UiEvent.SkilloptAutoApplied, { skill });
        } catch (err) {
          this.#core.emit(UiEvent.SkilloptAutoApplyFailed, { error: errorMessage(err) });
          // A passing failure (git busy, a full disk) leaves it for the next sweep.
          if (!(err instanceof SuggestionRefused)) break;
          await this.#core.discardStagedProposal(index, `could not be applied: ${errorMessage(err)}`, key, false);
        }
      }
    } finally {
      this.#x.autoApplying = false;
    }
  }

  // ── self-improving background: idle-time architect (A6, §6.5) ────────────────────────────
  touchActivity(): void {
    this.#x.lastActivity = Date.now();
  }

  startIdleWatch(): void {
    if (this.#x.idleTimer) return;
    const checkMs = this.#core.options.improvementIdle?.checkMs ?? ARCHITECT_CHECK_MS;
    this.#x.idleTimer = setInterval(
      () => {
        void this.maybeRunArchitect().catch((err) =>
          this.#core.options.onLog?.(`[architect] pass failed: ${errorMessage(err)}`, "stderr"),
        );
      },
      Math.max(ARCHITECT_MIN_CHECK_MS, checkMs),
    );
    this.#x.idleTimer.unref?.();
  }

  /** The settings that keep the architect off, or a pass already running. */
  #architectOff(): boolean {
    const { settings } = this.#x;
    const switchedOff = this.#backgroundImprovementOff() || !settings.selfImproving || !settings.architect;
    return switchedOff || this.#x.architectRunning || !this.#x.started;
  }

  /** All the reasons NOT to run, checked every tick; running is the rare case. */
  async maybeRunArchitect(): Promise<void> {
    if (this.#architectOff()) return;
    const idleMs = this.#core.options.improvementIdle?.idleMs ?? ARCHITECT_IDLE_MS;
    if (Date.now() - this.#x.lastActivity < idleMs) return;
    if (this.workInFlight()) return;
    if (!this.#core.budget.gate({ class: WorkClass.Improvement }).ok) return;
    // Pacing, not scheduling: one architect look per quiet stretch, never a hot loop.
    const minGapMs = this.#core.options.improvementIdle?.minGapMs ?? ARCHITECT_MIN_GAP_MS;
    const last = await this.#core.improvements.newestFinishedAt();
    let job = (await this.#core.improvements.pending())[0] ?? null;
    if (!job) {
      if (last && Date.now() - Date.parse(last) < minGapMs) return;
      job = await this.#core.improvements.queue("idle architect pass");
    }
    this.#x.architectRunning = true;
    try {
      await this.runArchitectJob(job.id);
    } finally {
      this.#x.architectRunning = false;
    }
  }

  /** First ready engine that can complete — local first, the subscription only as fallback. */
  async architectEngine(): Promise<ArchitectEngine | null> {
    for (const id of [EngineId.Ollama, ...SUBSCRIPTION_ENGINES]) {
      try {
        const engine = this.#core.engines.get(id);
        if (!engine.complete) continue;
        const status = await engine.status();
        if (status.code === EngineStatusCode.Ready) return { id, complete: engine.complete.bind(engine) };
      } catch {
        /* unregistered in this build — next */
      }
    }
    return null;
  }

  /** One architect call, gated by and counted against the improvement budget; its text. */
  async architectComplete(
    engine: { complete: (r: CompleteRequest) => Promise<CompleteResponse> },
    request: CompleteRequest,
  ): Promise<string> {
    const response = await this.#core.budget.run(WorkClass.Improvement, () => engine.complete(request));
    return String(response.message?.content ?? "");
  }

  /**
   * Harness files the architect may look at and rewrite — code (`.ts`, and `.mjs` in a workspace
   * from before the harness was TypeScript) and markdown, everything but the frozen judge/ and the
   * declaration files an app update replaces (`types/host-api.d.ts`).
   */
  async harnessFileList(): Promise<string[]> {
    const out: string[] = [];
    await collectArchitectFiles(this.#core.layout.harnessWs, this.#core.layout.harnessWs, 0, out);
    return out.sort();
  }

  /** A user run or a user turn began: the architect steps aside. */
  #userWorkArrived(): boolean {
    return this.#x.activeRunIds.size > 0 || this.#core.budget.userInFlight > 0;
  }

  async #requeueJob(jobId: string, note: string): Promise<void> {
    await this.#core.improvements.update(jobId, { status: ImprovementStatus.Queued, note });
  }

  async #finishJob(
    jobId: string,
    status: typeof ImprovementStatus.Rejected | typeof ImprovementStatus.Failed,
    note: string,
  ): Promise<void> {
    await this.#core.improvements.update(jobId, { status, note });
    if (status === ImprovementStatus.Failed) await this.noteImprovementFailure(note);
    this.#core.emit(UiEvent.ImprovementFinished, { id: jobId, status, note });
  }

  /**
   * Architect job v1 (deliberately modest, §6.5): propose ONE structural change, validate it in
   * a harness worktree with a boot healthcheck, then apply with snapshots on both sides. Every
   * stage checkpoints in the journal; a user run appearing mid-job requeues the rest.
   */
  async runArchitectJob(jobId: string): Promise<void> {
    await this.#core.improvements.update(jobId, { status: ImprovementStatus.Validating });
    const engine = await this.architectEngine();
    if (!engine) return this.#requeueJob(jobId, "no ready engine");

    // 1. Pick a target, given the live self plus the evidence trail.
    const pick = await this.#pickArchitectTarget(engine);
    if (isRefusal(pick)) return this.#finishJob(jobId, ImprovementStatus.Rejected, pick.refused);
    if (this.#userWorkArrived()) return this.#requeueJob(jobId, "user work arrived");

    // 2. Ask for the full rewrite of that one file.
    const rewrite = await this.#rewriteArchitectTarget(engine, pick);
    if (isRefusal(rewrite)) return this.#finishJob(jobId, ImprovementStatus.Rejected, rewrite.refused);
    await this.#core.improvements.update(jobId, { proposal: { file: pick.relative, reason: rewrite.reason } });
    if (this.#userWorkArrived()) return this.#requeueJob(jobId, "user work arrived");

    // 3. Validate in a fork: a worktree of the harness workspace must type-check (code only) and
    //    boot and pass healthcheck with the change in place (the self-edit gate's fork). The live
    //    self keeps running untouched throughout.
    const failure = await this.#validateInFork(jobId, pick.relative, rewrite.contents);
    if (failure) return this.#finishJob(jobId, ImprovementStatus.Failed, failure);
    if (this.#userWorkArrived()) return this.#requeueJob(jobId, "user work arrived");

    // 4. Apply, armored: snapshot before, healthy snapshot after, durable record, loud card.
    await this.#applyArchitectChange(jobId, pick.relative, rewrite);
  }

  async #pickArchitectTarget(engine: ArchitectEngine): Promise<ArchitectPick | Refusal> {
    const files = await this.harnessFileList();
    const stepBuffer = (
      ((await this.#core.store.readArtifact(this.#core.mainThread, "skillopt_step_buffer").catch(() => null)) ??
        []) as unknown[]
    ).slice(-ARCHITECT_LESSONS_SHOWN);
    const pickRaw = await this.architectComplete(engine, {
      ...architectPickPrompt(files, stepBuffer),
      effort: ReasoningEffort.High,
      timeoutMs: ARCHITECT_PICK_TIMEOUT_MS,
    });
    const pick = extractJsonObject(pickRaw) as { file?: string | null; why?: string } | null;
    if (!pick) return { refused: "unparseable target pick" };
    if (!pick.file) return { refused: "architect proposed nothing" };
    const relative = String(pick.file);
    if (!files.includes(relative)) return { refused: `architect named a file outside its list: ${relative}` };
    return { relative, why: pick.why };
  }

  async #rewriteArchitectTarget(engine: ArchitectEngine, pick: ArchitectPick): Promise<ArchitectRewrite | Refusal> {
    const { relative } = pick;
    const target = path.join(this.#core.layout.harnessWs, relative);
    const original = await readFile(target, "utf8").catch(() => null);
    if (original === null || original.length > ARCHITECT_MAX_FILE_CHARS) {
      return { refused: `target unreadable or too large: ${relative}` };
    }
    const rewriteRaw = await this.architectComplete(engine, {
      ...architectRewritePrompt(relative, pick.why, original),
      effort: ReasoningEffort.High,
      timeoutMs: ARCHITECT_REWRITE_TIMEOUT_MS,
    });
    const reason = /REASON:\s*(.+)/.exec(rewriteRaw)?.[1]?.trim() ?? "architect improvement";
    const contents = /```(?:file|[a-z]*)\n([\s\S]*?)```/.exec(rewriteRaw)?.[1] ?? null;
    if (!contents?.trim()) return { refused: "architect returned no file body" };
    if (contents === original) return { refused: "architect returned the file unchanged" };
    return { target, reason, contents };
  }

  /** Try the rewrite in a fork of the harness; the failure note, or null when it passed. */
  async #validateInFork(jobId: string, relative: string, contents: string): Promise<string | null> {
    const gate = this.#x.selfEditGate;
    const forkDir = path.join(this.#core.layout.scratch, "architect", jobId);
    let verdict: ForkVerdict = { healthy: false, typeErrors: null };
    try {
      await gate.openFork(forkDir);
      verdict = await this.#tryInFork(forkDir, relative, contents);
    } catch (err) {
      this.#core.options.onLog?.(`[architect] fork validation failed: ${errorMessage(err)}`, "stderr");
    } finally {
      await gate.closeFork(forkDir);
    }
    if (verdict.typeErrors !== null)
      return `fork of ${relative} failed its type check — change discarded. ${verdict.typeErrors}`;
    if (!verdict.healthy) return `fork of ${relative} failed its boot healthcheck — change discarded`;
    return null;
  }

  async #tryInFork(forkDir: string, relative: string, contents: string): Promise<ForkVerdict> {
    const gate = this.#x.selfEditGate;
    const before = await readFile(path.join(forkDir, relative), "utf8").catch(() => null);
    await writeFile(path.join(forkDir, relative), contents);
    // A rewrite that adds a type error is refused before anything boots it — the same rule as
    // the agent's own edits, so errors the self already had do not block every architect job.
    const types = RUNS_AS_CODE.test(relative)
      ? await gate.typesAddedBy(forkDir, new Map([[relative, { before, after: contents }]]))
      : null;
    if (types && !types.ok) return { healthy: false, typeErrors: typeCheckText(types, ARCHITECT_TYPE_ERRORS_LIMIT) };
    // Booting is not the bar: the rewritten loop must still score, plan and brief
    // correctly. The self-test runs the v2 loop's pure logic against fixed inputs.
    const booted = await gate.boot(forkDir, { selftest: true });
    if (!booted.ok) {
      const what = booted.stage === "selftest" ? "fork failed the loop self-test" : "fork validation failed";
      this.#core.options.onLog?.(`[architect] ${what}: ${booted.message}`, "stderr");
    }
    return { healthy: booted.ok, typeErrors: null };
  }

  async #applyArchitectChange(jobId: string, relative: string, rewrite: ArchitectRewrite): Promise<void> {
    const { target, reason, contents } = rewrite;
    const snapshot = await this.#core.snapshot(SnapshotScope.Harness, `architect: ${reason}`);
    await writeFile(target, contents);
    const post = await this.#core.snapshot(
      SnapshotScope.Harness,
      `after architect: ${relative} — ${reason}`,
      undefined,
      true,
    );
    await this.#core.improvements.update(jobId, {
      status: ImprovementStatus.Applied,
      snapshot_id: snapshot.snapshot_id,
      post_snapshot_id: post.snapshot_id,
    });
    await this.#core.append([
      customEventData(CustomEvent.ImprovementApplied, {
        id: jobId,
        file: relative,
        reason,
        snapshot_id: snapshot.snapshot_id,
        post_snapshot_id: post.snapshot_id,
      }),
    ]);
    this.#core.emit(UiEvent.ImprovementApplied, { id: jobId, file: relative, reason });
    // Loop code loads on restart; tools and prompts reload per round. Either way the change is
    // live no later than the next restart, and the watchdog owns the failure path.
    if (!relative.startsWith("loop/")) return;
    await this.#restartForSelfChange(`architect: ${reason}`);
    const ok = await this.#core.host.healthcheck();
    if (!ok) await this.#core.recover(`architect change to ${relative} failed its live healthcheck`);
  }

  /** Restart the harness on a changed self; the caller checks it answers. */
  async #restartForSelfChange(detail: string): Promise<void> {
    await this.#x.recovery.releaseHarnessLeases();
    await this.#core.host.restart({
      type: DispatchActionType.BootNotice,
      notice: { reason: BootReason.SelfUpdate, detail },
    });
  }

  async noteImprovementFailure(note: string): Promise<void> {
    const buffer = ((await this.#core.store
      .readArtifact(this.#core.mainThread, "skillopt_step_buffer")
      .catch(() => null)) ?? []) as unknown[];
    buffer.push({ architect: true, why_rejected: note, at: new Date().toISOString() });
    await this.#core.store
      .writeArtifact(this.#core.mainThread, "skillopt_step_buffer", buffer.slice(-STEP_BUFFER_MAX_ENTRIES))
      .catch(() => {});
  }

  /** Testing hook: force one idle check now instead of waiting for the interval. */
  async runIdleCheckNow(): Promise<void> {
    await this.maybeRunArchitect();
  }

  selfChangeTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#x.applyChain.then(work);
    this.#x.applyChain = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  async stagedList(): Promise<StagedRecord[]> {
    const staged = await this.#core.store.readArtifact<StagedRecord[]>(this.#core.mainThread, "skillopt_staged");
    return Array.isArray(staged) ? staged : [];
  }

  /**
   * Take one suggestion off the list as it stands now, not as it stood when the apply began:
   * the harness may have staged another while a snapshot was being taken.
   */
  async removeStaged(proposal: StagedRecord): Promise<void> {
    const staged = await this.stagedList();
    const index = staged.findIndex(
      (p) => p.skill === proposal.skill && p.at === proposal.at && p.proposedText === proposal.proposedText,
    );
    if (index < 0) return;
    staged.splice(index, 1);
    await this.#core.store.writeArtifact(this.#core.mainThread, "skillopt_staged", staged);
  }

  async acceptStagedProposal(
    index: number,
    approvedBy: "human" | "auto",
    key?: { at?: string; skill?: string },
  ): Promise<{ skill: string }> {
    const staged = await this.stagedList();
    const proposal = staged[findStaged(staged, index, key)];
    if (!proposal) throw new Error(MESSAGE.suggestionGone);
    const { target: kind, skill, file } = proposalTarget(proposal);
    const lessons = kind === StagedTarget.Lessons;
    // The harness can plant links in its workspace and this process is not sandboxed: the file is
    // reached only through real folders of the workspace, and never through a link of its own.
    const target = await suggestionFile(this.#core.layout.harnessWs, file);
    // The first lessons suggestion starts their file; a skill's file must still be there.
    const current = await readSuggestionFile(target, lessons ? "" : null);
    if (current === null) throw new SuggestionRefused(MESSAGE.suggestionTargetGone);
    const text = rebaseProposal(proposal, current);

    const snapshot = await this.#core.snapshot(SnapshotScope.Harness, `skillopt: approved edits to ${skill}`);
    await writeSuggestionFile(target, text);
    // A skill keeps its accepted version beside it; lessons are no skill and leave no archive.
    if (!lessons) await writeSuggestionFile(path.join(path.dirname(target), `${skill}.best.md`), text);
    // The change's own "after": its exact diff, what an undo reverses, and — once it is known
    // to be as healthy as the last good version — the point a later rewind keeps it at.
    const post = await this.#core.snapshot(
      SnapshotScope.Harness,
      `after self-change: ${file} — approved edits to ${skill}`,
    );
    await this.#x.recovery.inheritHealth(post);

    await this.removeStaged(proposal);
    await this.#core.append([
      customEventData(CustomEvent.SkilloptAccepted, {
        ...(lessons ? { target: kind, file } : {}),
        skill,
        edits: proposal.edits,
        gate: proposal.gate,
        rationale: proposal.rationale,
        ...(proposal.title ? { title: proposal.title } : {}),
        ...(proposal.summary?.length ? { summary: proposal.summary } : {}),
        approvedBy,
        snapshot_id: snapshot.snapshot_id,
        post_snapshot_id: post.snapshot_id,
      }),
    ]);
    this.#core.emit(UiEvent.SkilloptAccepted, { skill, approvedBy });
    return { skill };
  }

  /**
   * Discard a staged proposal. A person's refusal is remembered so the idea is not proposed
   * again; a suggestion that merely went stale is not an idea anyone refused.
   */
  async discardStagedProposal(
    index: number,
    reason = "rejected by the user",
    key?: { at?: string; skill?: string },
    remember = true,
  ): Promise<void> {
    const staged = await this.stagedList();
    const proposal = staged[findStaged(staged, index, key)];
    if (!proposal) return;
    await this.removeStaged(proposal);
    if (remember) await this.rememberRefusal({ skill: proposal.skill, edits: proposal.edits, why_rejected: reason });
    await this.#core.append([
      customEventData(CustomEvent.SkilloptRejected, {
        skill: proposal.skill,
        reason,
        by: remember ? "human" : "auto",
      }),
    ]);
    this.#core.emit(UiEvent.SkilloptDiscarded, { skill: proposal.skill });
  }

  /** The step buffer the analyst reads, so a refused idea stops coming back. */
  async rememberRefusal(entry: { skill?: string; edits?: unknown; why_rejected: string }): Promise<void> {
    const buffer = ((await this.#core.store.readArtifact(this.#core.mainThread, "skillopt_step_buffer")) ??
      []) as unknown[];
    buffer.push({ ...entry, at: new Date().toISOString() });
    await this.#core.store.writeArtifact(
      this.#core.mainThread,
      "skillopt_step_buffer",
      buffer.slice(-STEP_BUFFER_MAX_ENTRIES),
    );
  }

  /** A run, a contractor or a user turn in flight: restarting the harness now would cut it off. */
  workInFlight(): boolean {
    return this.#x.activeRunIds.size > 0 || this.#x.activeDelegations.size > 0 || this.#core.budget.userInFlight > 0;
  }

  async undoSelfChange(snapshotId: string): Promise<{ file: string }> {
    const events = await this.#core.activityEvents();
    const change = changeRecords(events).find((record) => record.snapshotId === snapshotId);
    if (!change) throw new Error(MESSAGE.changeNotFound);
    if (undoneSelfChanges(events).has(snapshotId)) throw new Error(MESSAGE.changeAlreadyUndone);
    const before = this.#core.snapshotIndex.get(snapshotId)?.git.harness;
    if (!before) throw new Error(MESSAGE.changeBaseGone);
    const code = change.file.startsWith("loop/");
    if (code && this.workInFlight()) throw new Error(MESSAGE.undoWhileBuilding);
    const after = (
      (change.postSnapshotId ? this.#core.snapshotIndex.get(change.postSnapshotId) : undefined) ??
      this.nextHarnessSnapshot(snapshotId)
    )?.git.harness;
    let reverted: boolean;
    try {
      reverted = await this.#core.snapshots.revert("harness", before, after, [change.file]);
    } catch {
      throw new Error(MESSAGE.undoConflict);
    }
    if (!reverted) throw new Error(MESSAGE.changeAlreadyGone);
    await this.#archiveSkill(change);
    const undo = await this.#core.snapshot(SnapshotScope.Harness, `after undo: ${change.file}`);
    await this.#x.recovery.inheritHealth(undo);
    await this.#core.append([
      customEventData(CustomEvent.SelfChangeUndone, {
        snapshot_id: snapshotId,
        undo_snapshot_id: undo.snapshot_id,
        file: change.file,
        ...(change.skill ? { skill: change.skill } : {}),
        by: "human",
      }),
    ]);
    // An undo is the plainest verdict there is on a change; the analyst hears it like a discard.
    if (change.skill)
      await this.rememberRefusal({
        skill: change.skill,
        edits: change.edits,
        why_rejected: "the user undid it after it was applied",
      });
    this.#core.emit(UiEvent.SelfchangeUndone, { snapshotId, file: change.file });
    if (code) {
      await this.#restartForSelfChange(`undo: ${change.file}`);
      if (!(await this.#core.host.healthcheck()))
        await this.#core.recover(`undoing ${change.file} failed its live healthcheck`);
    }
    return { file: change.file };
  }

  /** An undone skill edit's skill keeps its live text as its accepted version; lessons keep no archive. */
  async #archiveSkill(change: ChangeRecord): Promise<void> {
    if (!change.skill || change.target === StagedTarget.Lessons) return;
    const live = await readFile(path.join(this.#core.layout.harnessWs, change.file), "utf8");
    await writeFile(path.join(this.#core.layout.harnessWs, "skills", `${change.skill}.best.md`), live);
  }

  /**
   * For a change that recorded no after-snapshot: the first later snapshot that carries the
   * harness. Undefined means only the working tree holds the change.
   */
  nextHarnessSnapshot(snapshotId: string): SnapshotRecord | undefined {
    const records = this.#core.snapshotIndex.all();
    const at = records.findIndex((record) => record.snapshot_id === snapshotId);
    return at < 0 ? undefined : records.slice(at + 1).find((record) => record.git.harness);
  }

  /**
   * The learned changes Activity lists, each with its own diff: between the snapshots around
   * it, and only in the file it wrote. Pairing a change with whatever snapshot came next showed
   * an app update's code as part of an approved suggestion. The harness's own guardian restarts
   * are Studio maintaining itself, not something it learned, and are not listed.
   */
  async selfChangeList(
    limit = 30,
  ): Promise<
    Array<{ from: string; to: string; reason: string; file: string; at: string; healthy: boolean; diff: string }>
  > {
    const out: Array<{
      from: string;
      to: string;
      reason: string;
      file: string;
      at: string;
      healthy: boolean;
      diff: string;
    }> = [];
    for (const change of changeRecords(await this.#core.activityEvents()).reverse()) {
      if (out.length >= limit) break;
      const before = this.#core.snapshotIndex.get(change.snapshotId);
      if (!before?.git.harness) continue;
      const after =
        (change.postSnapshotId ? this.#core.snapshotIndex.get(change.postSnapshotId) : undefined) ??
        this.nextHarnessSnapshot(change.snapshotId);
      out.push({
        from: change.snapshotId,
        to: after?.snapshot_id ?? "current",
        reason: before.reason,
        file: change.file,
        at: before.created_at,
        healthy: before.healthy,
        diff: await this.changeDiff(before.git.harness, after?.git.harness, [change.file]),
      });
    }
    return out;
  }

  async changeDiff(from: string, to: string | undefined, paths: string[]): Promise<string> {
    const key = `${from}..${to ?? ""}:${paths.join(",")}`;
    const cached = this.#x.changeDiffs.get(key);
    if (cached !== undefined) {
      this.#x.changeDiffs.delete(key);
      this.#x.changeDiffs.set(key, cached);
      return cached;
    }
    const diff = (
      await this.#core.snapshots.patch("harness", from, to, paths, { binary: false }).catch(() => "")
    ).slice(0, CHANGE_DIFF_MAX_CHARS);
    // Two commits never change; a diff out to the working tree does.
    if (to) {
      this.#x.changeDiffs.set(key, diff);
      while (this.#x.changeDiffs.size > CHANGE_DIFFS_KEPT) {
        const oldest = this.#x.changeDiffs.keys().next().value;
        if (oldest !== undefined) this.#x.changeDiffs.delete(oldest);
      }
    }
    return diff;
  }
}

/** Tolerant JSON-object extraction from model output (fenced or bare); null on failure. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
