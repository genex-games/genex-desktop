/**
 * SkillOpt — the outer loop that improves the studio's skills between runs (PLAN.md §8.2).
 *
 * Ported mechanics from microsoft/SkillOpt:
 *  - **bounded edits**: four string-anchored ops, ≤4 proposed per analyst call, applied in small
 *    batches, never touching a `<!-- SLOW_UPDATE -->` region;
 *  - **failure-priority merge then ranking** by systematic impact;
 *  - **a gate**: an edit is kept only on strict improvement against a held-out set, and rejected
 *    edits go into a step buffer the next analyst call sees, so dead ideas stop coming back;
 *  - `best_skill.md` per skill, with the accepted history in the log.
 *
 * Adapted for this product, where a full validation run costs hours (the plan's §8.2 note):
 * validation uses **cheap replayable sub-tasks mined from run transcripts**, and the gate is
 * pairwise and blind — candidate output against current output, tie ⇒ reject.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, loadSkills } from "./skills.ts";
import { modelOn, EngineId } from "./model-roles.ts";
import { LIGHT_EFFORT } from "./config.ts";
import { BallotLetter, parseVerdict, Side } from "./judge.ts";
import { CompletionRole, promptSha256 } from "./judge-provenance.ts";
import { loadContractLessons } from "./library.ts";
import {
  CONTRACT_LESSONS_FILE,
  LESSONS_HEADER,
  LESSONS_SKILL,
  StagedTarget,
  isLessonsRecord,
  lessonEdits,
  lessonLine,
  lessonsInEdits,
  pendingLessons,
  refusedLessons,
} from "./contract-lessons.ts";
import { LESSONS_WORDS, MAX_LESSONS_PROPOSED, lessonsPrompt } from "./skillopt-prompts.ts";
import type { AnyRecord, HarnessCtx, HarnessEvent } from "../types/harness.d.ts";
import type { Skill, SkillEdit } from "./skills.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { EngineFailure } from "./outage.ts";
import { VerdictSource } from "./verdict.ts";
import { WorkerState } from "./outcomes.ts";
import { clip, CLIP_DETAIL, CLIP_REASON } from "./text.ts";
import type { HarnessWorkClass } from "../types/host-api.d.ts";

/**
 * Every model call a pass makes is improvement work. Without the tag the host books it as user
 * work, so the budget ledger never refuses a pass while a build is running and never counts it
 * against the improvement share (`substrate/budget.ts`).
 */
const IMPROVEMENT_WORK: HarnessWorkClass = "improvement";

/** A replayable sub-task mined from the log: what was asked, whether it went well, and what showed it. */
export interface ValidationTask {
  id: string;
  prompt: string;
  success: boolean;
  evidence: AnyRecord;
  skills: string[];
}
/** An edit the gate refused, kept so the next analyst call does not propose it again. */
interface Refusal {
  skill: string;
  edits: SkillEdit[];
  why_rejected: string;
  at: string;
}
/** The blind pairwise gate's answer. */
interface Gate {
  accept: boolean;
  reason: string;
  votes: string;
}
/** What one analyst call proposed. */
interface Proposal {
  edits: SkillEdit[];
  rationale: string;
  title: string;
  summary: string[];
}
/** A gated proposal, as it is staged, applied or logged. */
interface ProposalEntry {
  skill: string;
  edits: SkillEdit[];
  applied: number;
  gate: Gate;
  rationale: string;
  title: string;
  summary: string[];
}
/** How a pass is started: the post-run pass hands in the run's engine; a manual pass may not. */
export interface SkillOptOptions {
  threadId?: string;
  /**
   * Accepted and ignored: applying a suggestion is the host's (Settings → Harness → Apply
   * suggestions automatically, with learning on). A pass only ever stages.
   */
  autoApply?: boolean;
  engine?: string;
  model?: string;
  maxTasks?: number;
}
/** What a pass did, logged as `skillopt_pass`. */
export interface SkillOptReport {
  proposals: Array<
    ProposalEntry | { skill: string; applied: number; rejected: Array<{ edit: SkillEdit; reason: string }> }
  >;
  accepted: number;
  rejected: number;
  staged: number;
  tasks: number;
  skills: string[];
  note?: string;
  lessons?: AnyRecord;
}

/** The most skill edits one analyst proposal may carry. */
const MAX_EDITS_PER_CALL = 4;
/** How many mined tasks a pass learns from when the caller names no limit. */
const DEFAULT_MAX_TASKS = 12;
/** The artifact that keeps refused edits, so the analyst does not propose them again. */
const STEP_BUFFER = "skillopt_step_buffer";
/** How many refusals the step buffer keeps. */
const STEP_BUFFER_LIMIT = 50;
/** A lesson worth staging is longer than a fragment and shorter than a paragraph; a pass stages a few. */
const MIN_LESSON_CHARS = 12;
const MAX_LESSON_CHARS = 240;
/** The artifact the host reads its staged suggestions from: skill edits and the lessons. */
const STAGED = "skillopt_staged";
/** The problems a gate refusal's task keeps as evidence. */
const GATE_PROBLEMS_KEPT = 3;
/** The refused edits the analyst is reminded of, the newest. */
const REJECTED_EDITS_SHOWN = 10;
/** A proposal's plain title, and the lines of its plain summary. */
const PROPOSAL_TITLE_CHARS = 90;
const SUMMARY_LINES = 3;

/** One self-improvement pass in flight: its model, its tasks, its refusals and its report. */
interface Pass {
  threadId: string | undefined;
  engine: string;
  model: string | undefined;
  tasks: ValidationTask[];
  skills: Skill[];
  stepBuffer: Refusal[];
  /**
   * What this pass refused, appended to the buffer as it stands when the pass ends: a pass
   * takes minutes, and writing back the copy it started with dropped whatever the user
   * discarded meanwhile.
   */
  refused: Refusal[];
  report: SkillOptReport;
  /** The whole log the pass mines, in one global order. */
  events: HarnessEvent[];
}

/** The engine stopped the call, or the user pressed Stop. */
function stoppedWork(ctx: HarnessCtx, err: any): boolean {
  return err?.kind === EngineFailure.Aborted || Boolean(ctx.cancelled);
}

/** The pass's note when Stop reached it between (or during) skills. */
function stoppedNote(index: number, total: number): string {
  return `stopped by the user after ${index} of ${total} skills`;
}

export async function runSkillOpt(ctx: HarnessCtx, options: SkillOptOptions = {}): Promise<SkillOptReport> {
  const pass = await openPass(ctx, options);
  const { report, skills, threadId } = pass;
  pass.stepBuffer = ((await ctx.call(HostMethod.ArtifactRead, { artifactId: STEP_BUFFER })) ?? []) as Refusal[];

  // The second target (WP8): what the builders wrote under `## Fixed by looking` and after
  // `HARNESS:` across runs becomes candidate lines for the contract every brief carries. They
  // are staged for the host like a skill edit — applied when the user's switches allow it,
  // listed in Activity otherwise — and need no judged round to learn from.
  if (!(await learnLessons(ctx, pass))) return finishPass(ctx, threadId, report);
  if (pass.tasks.length === 0) {
    if (!report.lessons?.staged) report.note = "nothing to learn from yet — build or run something first";
    return finishPass(ctx, threadId, report);
  }

  for (const [index, skill] of skills.entries()) {
    // The stop button reaches the pass too — a pass is minutes of local-model time per skill,
    // and "stop means stop" would be a lie if it only applied to the run before it.
    if (ctx.cancelled) {
      report.note = stoppedNote(index, skills.length);
      break;
    }
    ctx.setStatus?.(`self-improving · ${skill.slug} (${index + 1}/${skills.length})`);
    const outcome = await improveSkill(ctx, pass, skill);
    if (outcome === SkillStep.Stopped) {
      report.note = stoppedNote(index, skills.length);
      break;
    }
  }

  // Rejected edits stay visible to future analyst calls so they are not re-proposed.
  if (pass.refused.length > 0) {
    const latest = ((await ctx.call(HostMethod.ArtifactRead, { artifactId: STEP_BUFFER })) ?? []) as Refusal[];
    await ctx.call(HostMethod.ArtifactWrite, {
      artifactId: STEP_BUFFER,
      value: [...latest, ...pass.refused].slice(-STEP_BUFFER_LIMIT),
    });
  }
  return finishPass(ctx, threadId, report);
}

/**
 * The builders' lessons, distilled and staged into the pass's report. False when the user stopped
 * the pass during it; any other failure leaves the skills to learn on without them.
 */
async function learnLessons(ctx: HarnessCtx, pass: Pass): Promise<boolean> {
  try {
    const lessons = await distillLessons(ctx, pass);
    if (lessons) pass.report.lessons = lessons;
    if (lessons?.staged) pass.report.staged++;
    return true;
  } catch (err: any) {
    return !stoppedWork(ctx, err);
  }
}

/** The pass's evidence, model, tasks and trainable skills, with an empty report. */
async function openPass(ctx: HarnessCtx, options: SkillOptOptions): Promise<Pass> {
  const events = await collectEvidence(ctx, options.threadId);
  // Self-improvement runs on the model that produced the evidence: the post-run pass hands in
  // the run's engine, and a manual pass falls back to the engine of the last run on record.
  // The local model is only the floor when nothing has ever run.
  const lastRun = latestRunEngine(events);
  const engine = options.engine ?? lastRun?.engine ?? EngineId.Ollama;
  const model = options.engine ? options.model : (options.model ?? lastRun?.model);
  const tasks = mineValidationTasks(events, options.maxTasks ?? DEFAULT_MAX_TASKS);
  // Only skills that declare `trainable: true` are optimised — the planner's, in the v2 seed.
  // Builder skills are retired from SkillOpt (HARNESS-REWORK.md §4.6): the Claude Code
  // contractor never read them, and the technique library with its outcome gate replaces
  // text votes for what reaches a builder.
  const skills = (await loadSkills(ctx.workspace)).filter((skill) => isTrainable(skill));
  return {
    threadId: options.threadId,
    engine,
    model,
    events,
    tasks,
    skills,
    stepBuffer: [],
    refused: [],
    report: {
      proposals: [],
      accepted: 0,
      rejected: 0,
      staged: 0,
      tasks: tasks.length,
      skills: skills.map((s) => s.slug),
    },
  };
}

/** How one skill's turn in the pass ended: judged (or skipped), or stopped by the user. */
const SkillStep = { Done: "done", Stopped: "stopped" } as const;
type SkillStep = (typeof SkillStep)[keyof typeof SkillStep];

/** `work`, or null when the user stopped it: Stop aborts the in-flight model call itself, and that is a stop, not a broken pass. */
async function unlessStopped<T>(ctx: HarnessCtx, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (err: any) {
    if (stoppedWork(ctx, err)) return null;
    throw err;
  }
}

/** Analyse one skill's tasks, apply the ranked edits to a copy, and gate the copy on held-out tasks. */
async function improveSkill(ctx: HarnessCtx, pass: Pass, skill: Skill): Promise<SkillStep> {
  const { engine, model } = pass;
  const relevant = pass.tasks.filter((task) => task.skills.includes(skill.slug) || task.skills.length === 0);
  // The analyst learns from one half and the gate judges on the other. When the analyst saw
  // every task, its candidate restated the very failures the gate then asked about, and all
  // 55 candidates a real install staged won 3/3.
  const { train, held } = splitTasks(relevant);
  if (held.length === 0) return SkillStep.Done;

  // ① analyse — look for COMMON patterns, propose generalisable edits only
  const proposal = await unlessStopped(ctx, () =>
    analyse(ctx, {
      engine,
      model,
      skill,
      failures: train.filter((task) => !task.success),
      successes: train.filter((task) => task.success),
      stepBuffer: pass.stepBuffer.filter((entry) => entry?.skill === skill.slug && Array.isArray(entry.edits)),
    }),
  );
  if (!proposal) return SkillStep.Stopped;
  if (!proposal.edits?.length) return SkillStep.Done;

  // ② failure-priority merge, ③ rank and clip to the edit budget
  const ranked = rankEdits(proposal.edits).slice(0, MAX_EDITS_PER_CALL);

  // ④ apply the bounded ops to a candidate copy
  const candidate = applyEdits(skill.raw, ranked);
  if (candidate.applied.length === 0) {
    pass.report.proposals.push({ skill: skill.slug, applied: 0, rejected: candidate.rejected });
    return SkillStep.Done;
  }

  // ⑤ gate: blind pairwise comparison on held-out tasks, tie ⇒ reject
  const gate = await unlessStopped(ctx, () =>
    gateCandidate(ctx, { engine, model, skill, candidateText: candidate.text, tasks: held }),
  );
  if (!gate) return SkillStep.Stopped;

  const entry: ProposalEntry = {
    skill: skill.slug,
    edits: ranked,
    applied: candidate.applied.length,
    gate,
    rationale: proposal.rationale ?? "",
    title: proposal.title ?? "",
    summary: proposal.summary ?? [],
  };
  await settleProposal(ctx, pass, skill, candidate.text, entry);
  pass.report.proposals.push(entry);
  return SkillStep.Done;
}

/**
 * A gated candidate: staged when it won — the host applies it at once when the user's switches
 * allow, and lists it for review otherwise — refused and remembered when it did not.
 */
async function settleProposal(
  ctx: HarnessCtx,
  pass: Pass,
  skill: Skill,
  candidateText: string,
  entry: ProposalEntry,
): Promise<void> {
  const { report } = pass;
  if (entry.gate.accept) {
    await stageProposal(ctx, skill, candidateText, entry);
    report.staged++;
    return;
  }
  const refusal: Refusal = {
    skill: skill.slug,
    edits: entry.edits,
    why_rejected: entry.gate.reason,
    at: new Date().toISOString(),
  };
  pass.stepBuffer.push(refusal);
  pass.refused.push(refusal);
  await ctx.call(HostMethod.EventsAppend, {
    threadId: pass.threadId,
    batch: [{ type: EventKind.Custom, event_type: RunEvent.SkilloptRejected, payload: entry }],
  });
  report.rejected++;
}

/** `trainable: true` in the frontmatter opts a skill into SkillOpt; everything else is curated by hand. */
/** `facet_lessons` events → the prose the builders left behind, deduplicated. */
export function mineLessons(
  events: readonly HarnessEvent[],
  limit = 40,
): Array<{ text: string; facetId: string | null; runId: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ text: string; facetId: string | null; runId: string | null }> = [];
  for (const event of events) {
    if (event.data?.type !== EventKind.Custom || event.data.event_type !== RunEvent.FacetLessons) continue;
    for (const line of event.data.payload?.lessons ?? []) {
      const text = String(line ?? "").trim();
      const key = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push({ text, facetId: event.data.payload?.facetId ?? null, runId: event.data.payload?.runId ?? null });
    }
  }
  return out.slice(-limit);
}

/** What one lessons pass proposed, as the pass report keeps it. */
interface LessonsOutcome {
  added: number;
  removed: number;
  staged: boolean;
  lessons?: string[];
}

/**
 * The builders' notes → one lessons suggestion for the host. Lessons already in the file, waiting
 * in an earlier suggestion, or refused by the person are never proposed again: the file used to
 * stay empty, so every pass proposed the same lines.
 */
async function distillLessons(ctx: HarnessCtx, pass: Pass): Promise<LessonsOutcome | null> {
  const mined = mineLessons(pass.events);
  if (mined.length === 0) return null;
  const current = await loadContractLessons(ctx.workspace);
  const pending = pendingLessons(await ctx.call(HostMethod.ArtifactRead, { artifactId: STAGED }));
  const refused = refusedLessons(pass.stepBuffer);
  const known = [...new Set([...current, ...pending.add])];
  const { systemPrompt, userContent } = lessonsPrompt(known, mined);
  const response = await ctx.call(HostMethod.EngineComplete, {
    engine: pass.engine,
    model: pass.model,
    class: IMPROVEMENT_WORK,
    systemPrompt,
    stream: false,
    effort: LIGHT_EFFORT,
    messages: [{ role: "user", content: userContent }],
  });
  const parsed = parseVerdict(response.message?.content ?? "");
  const proposed = (Array.isArray(parsed.add) ? parsed.add : [])
    .map(lessonLine)
    .filter((lesson: string) => lesson.length > MIN_LESSON_CHARS && lesson.length <= MAX_LESSON_CHARS)
    .filter((lesson: string) => !known.includes(lesson) && !refused.has(lesson))
    .slice(0, MAX_LESSONS_PROPOSED);
  const named: string[] = (Array.isArray(parsed.remove) ? parsed.remove : []).map(lessonLine);
  if (proposed.length === 0 && named.length === 0) return { added: 0, removed: 0, staged: false };
  // The suggestion still waiting is folded into this one, so one waits at a time and none is lost.
  // A waiting lesson the distiller now takes out leaves the suggestion: the file never had it.
  const add = [...pending.add, ...proposed].filter((lesson) => !refused.has(lesson) && !named.includes(lesson));
  const remove = [...new Set([...pending.remove, ...named])];
  const rationale = clip(parsed.rationale, CLIP_REASON);
  const counted = await stageLessons(ctx, { add, remove, rationale });
  if (!counted) return { added: 0, removed: 0, staged: false };
  return { ...counted, staged: true, lessons: proposed };
}

/**
 * Stage the lessons as one suggestion in `skillopt_staged`, in place of any lessons suggestion
 * still waiting, and tell the host: its sweep applies it when learning and automatic apply are
 * both on, and Activity lists it otherwise.
 */
async function stageLessons(
  ctx: HarnessCtx,
  { add, remove, rationale }: { add: string[]; remove: string[]; rationale: string },
): Promise<{ added: number; removed: number } | null> {
  // Read again now, not when the pass began: the model call takes a while, and the host may
  // have applied or discarded a suggestion meanwhile.
  const currentText = await readFile(path.join(ctx.workspace, CONTRACT_LESSONS_FILE), "utf8").catch(() => "");
  const current = await loadContractLessons(ctx.workspace);
  const { edits } = lessonEdits(current, add, remove);
  // A file nobody wrote yet starts with its header, so whoever opens it knows what it is.
  const header = currentText.trim() ? [] : [{ op: "append", text: LESSONS_HEADER }];
  const change = applyEdits(currentText, [...header, ...edits]);
  const counted = lessonsInEdits(change.applied);
  if (counted.add.length + counted.remove.length === 0) {
    // Nothing left to change: a suggestion still waiting is withdrawn, not left to apply.
    await replaceLessonsRecord(ctx, null);
    return null;
  }
  const summary = [
    counted.add.length ? LESSONS_WORDS.added(counted.add.length) : "",
    counted.remove.length ? LESSONS_WORDS.removed(counted.remove.length) : "",
  ].filter(Boolean);
  const record = {
    target: StagedTarget.Lessons,
    skill: LESSONS_SKILL,
    file: CONTRACT_LESSONS_FILE,
    currentText,
    proposedText: change.text,
    edits: change.applied,
    rationale,
    title: counted.add.length ? LESSONS_WORDS.title : LESSONS_WORDS.removeTitle,
    summary,
    at: new Date().toISOString(),
  };
  await replaceLessonsRecord(ctx, record);
  const payload = { target: record.target, skill: record.skill, title: record.title, summary, rationale };
  await ctx.call(HostMethod.EventsAppend, {
    batch: [{ type: EventKind.Custom, event_type: RunEvent.SkilloptStaged, payload }],
  });
  ctx.notify("skillopt.staged", { skill: LESSONS_SKILL });
  return { added: counted.add.length, removed: counted.remove.length };
}

/** `skillopt_staged` with this record in place of any lessons suggestion waiting; none takes it out. */
async function replaceLessonsRecord(ctx: HarnessCtx, record: AnyRecord | null): Promise<void> {
  const staged = ((await ctx.call(HostMethod.ArtifactRead, { artifactId: STAGED })) ?? []) as AnyRecord[];
  const others = staged.filter((entry) => !isLessonsRecord(entry));
  if (!record && others.length === staged.length) return;
  await ctx.call(HostMethod.ArtifactWrite, { artifactId: STAGED, value: record ? [...others, record] : others });
}

export function isTrainable(skill: Pick<Skill, "frontmatter"> | null | undefined): boolean {
  const flag = String(skill?.frontmatter?.trainable ?? "")
    .trim()
    .toLowerCase();
  return flag === "true" || flag === "yes";
}

/** The engine of the most recent run on record, so lessons are judged by the model that earned them. */
function latestRunEngine(events: readonly HarnessEvent[]): { engine: string; model: string | undefined } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = events[i]?.data;
    const runStarted = d?.type === EventKind.Custom && d.event_type === RunEvent.RunStarted;
    if (runStarted && d.payload?.engine) {
      return { engine: d.payload.engine, model: modelOn(d.payload, d.payload.engine) };
    }
  }
  return null;
}

/**
 * Evidence lives wherever it happened. Chat builds log to their game's thread and runs log to
 * theirs, so a pass that read only one thread would starve — mine the whole log, in one global
 * (UUIDv7) order.
 */
async function collectEvidence(ctx: HarnessCtx, threadId: string | undefined): Promise<HarnessEvent[]> {
  const threads = await ctx.call(HostMethod.ThreadList, {}).catch(() => null);
  if (!Array.isArray(threads) || threads.length === 0) {
    return (await ctx.call(HostMethod.EventsList, { threadId })) ?? [];
  }
  const all: HarnessEvent[] = [];
  for (const thread of threads) {
    all.push(...((await ctx.call(HostMethod.EventsList, { threadId: thread.id }).catch(() => null)) ?? []));
  }
  all.sort(byId);
  return all;
}

/** Events in their global (UUIDv7) order. */
function byId(a: HarnessEvent, b: HarnessEvent): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Every pass leaves a visible trace, even an empty one — a button that says nothing feels dead. */
async function finishPass(
  ctx: HarnessCtx,
  threadId: string | undefined,
  report: SkillOptReport,
): Promise<SkillOptReport> {
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [{ type: EventKind.Custom, event_type: RunEvent.SkilloptPass, payload: report }],
  });
  return report;
}

/**
 * Cheap, replayable sub-tasks mined from what actually happened, rather than a synthetic
 * benchmark: iteration verdicts carry the gap that was being closed and whether it won.
 */
export function mineValidationTasks(events: readonly HarnessEvent[], limit: number): ValidationTask[] {
  const tasks: ValidationTask[] = [];
  for (const event of events) {
    if (event.data?.type !== EventKind.Custom) continue;
    const type = event.data.event_type;
    const mine = Object.hasOwn(TASK_MINERS, type) ? TASK_MINERS[type] : undefined;
    const task = mine?.(event.data.payload ?? {}, tasks.length);
    if (task) tasks.push(task);
  }
  return tasks.filter((task) => task.prompt).slice(-limit);
}

/** One custom event's payload → the task it teaches, or null. `mined` counts the tasks so far. */
type TaskMiner = (payload: AnyRecord, mined: number) => ValidationTask | null;

/** The verdict sources of a fully judged round; a record without one predates the field. */
const JUDGED_SOURCES: readonly string[] = [
  VerdictSource.Checks,
  VerdictSource.Taste,
  VerdictSource.TasteVeto,
  VerdictSource.Legacy,
];

/**
 * Autopilot facet iterations are run iterations at facet scope — same lesson shape, and
 * the facet title keeps the gap attributable ("Terrain: no depth in the fog").
 */
function facetIterationTask(payload: AnyRecord, mined: number): ValidationTask | null {
  // A round the lead pulled off mid-flight is not the builder's failure and must not be
  // scored as one — but it is a decision the lead made, and the playbook is what decides it.
  if (payload.verdictSource === VerdictSource.Stopped) {
    return {
      id: `stopped-${payload.facetId ?? "?"}-${payload.iteration ?? mined}`,
      prompt: `a round was stopped before it could be judged: ${[payload.facetTitle, payload.reason].filter(Boolean).join(" — ")}`,
      success: false,
      evidence: { facetId: payload.facetId ?? null, iteration: payload.iteration ?? null },
      skills: ["director"],
    };
  }
  // Only fully measured, judged iterations teach anything: a broken build, an outage, or a
  // board with unmeasured checks once produced a "lesson" from a phantom failure.
  // A record without a verdictSource predates the field and is taken as judged.
  const judged = !payload.verdictSource || JUDGED_SOURCES.includes(payload.verdictSource);
  const fullyMeasured = !payload.scoreboard || Number(payload.scoreboard.unmeasured ?? 0) === 0;
  if (!judged || !fullyMeasured) return null;
  return {
    id: `facet-${payload.facetId ?? "?"}-${payload.iteration ?? mined}`,
    prompt: [payload.facetTitle, payload.biggest_gap].filter(Boolean).join(": "),
    success: payload.winner === Side.Challenger,
    evidence: { satisfied: payload.satisfied === true, facetId: payload.facetId ?? null },
    skills: [],
  };
}

/** A builder the director refused at the gate, before it started. */
function gateRefusalTask(payload: AnyRecord, mined: number): ValidationTask | null {
  if (payload.pass !== "gate" || payload.decision?.kept !== false) return null;
  return {
    id: `gate-${payload.build?.worker ?? mined}`,
    prompt: `a builder was refused before it started: ${payload.because ?? "the build it would fork from did not run"}`,
    success: false,
    evidence: {
      worker: payload.build?.worker ?? null,
      problems: (payload.observed?.problems ?? []).slice(0, GATE_PROBLEMS_KEPT),
    },
    skills: ["director"],
  };
}

/** A director's builder that failed or was stopped, and said why. */
function endedWorkerTask(payload: AnyRecord, mined: number): ValidationTask | null {
  const ended = payload.state === WorkerState.Failed || payload.state === WorkerState.Stopped;
  if (!ended || !payload.stoppedBecause) return null;
  return {
    id: `worker-${payload.workerId ?? mined}`,
    prompt: `a builder ended as ${payload.state}: ${payload.title ?? payload.workerId} — ${payload.stoppedBecause}`,
    success: false,
    evidence: { worker: payload.workerId ?? null, state: payload.state },
    skills: ["director"],
  };
}

/** Whether the run ended with something the user can play is the only outcome that counts. */
function landingTask(payload: AnyRecord, mined: number): ValidationTask | null {
  const landing = payload.landingResult;
  if (!landing) return null;
  const madeLive = landing.ok ? "a build was made live" : "nothing was made live";
  const because = payload.stoppedBecause ? ` (${payload.stoppedBecause})` : "";
  return {
    id: `landing-${payload.runId ?? mined}`,
    prompt: `the build ended: ${landing.line ?? madeLive}${because}`,
    success: landing.ok === true,
    evidence: { how: landing.how ?? null, verified: landing.verified === true },
    skills: ["director"],
  };
}

/** Which events teach, and the task each one becomes. */
const TASK_MINERS: Partial<Record<string, TaskMiner>> = {
  [RunEvent.RunIteration]: (payload, mined) => ({
    id: `${payload.iteration ?? mined}`,
    prompt: payload.biggest_gap ?? "",
    success: payload.winner === Side.Challenger,
    evidence: { state: payload.state ?? null, consoleErrors: payload.consoleErrors ?? [] },
    skills: [],
  }),
  [RunEvent.FacetIteration]: facetIterationTask,
  // Decisions made without data are exactly what the decomposition skill should learn to
  // ask about (or default better) next time.
  [RunEvent.AutopilotDecision]: (payload, mined) => ({
    id: `decision-${mined}`,
    prompt: `a call was made without user data: ${payload.decision ?? ""}`,
    success: false,
    evidence: { decision: payload.decision ?? "" },
    skills: ["facet-decomposition"],
  }),
  // A director's run (director.ts) used to be nearly invisible here: the analyst saw its
  // facet iterations and nothing else, so the one thing that cost the first real run — a
  // fork point that did not run, which refused five builders before they started — taught
  // nobody. These three are what the run itself decided, and they answer to the playbook.
  [RunEvent.DirectorVerdict]: gateRefusalTask,
  [RunEvent.DirectorWorker]: endedWorkerTask,
  [RunEvent.RunFinished]: landingTask,
  [RunEvent.ToolFailure]: (payload, mined) => ({
    id: `tool-${mined}`,
    prompt: payload.summary ?? "",
    success: false,
    skills: [],
    evidence: payload,
  }),
  // Chat builds count too: a delegated build that ships console errors (or fails outright)
  // is a trajectory worth learning from, exactly like a lost run iteration.
  [RunEvent.BuildObservation]: (payload, mined) => ({
    id: `build-${mined}`,
    prompt: payload.brief ?? "",
    success: payload.ok === true && (payload.consoleErrors ?? 0) === 0,
    evidence: { summary: payload.summary ?? "", consoleErrors: payload.consoleErrors ?? 0 },
    skills: [],
  }),
};

/** How a proposal is described for the person who uses the app: the analyst's and the describer's rules. */
const PLAIN_WORDS_RULES = [
  "They are not technical and never read this file. `title`: at most eight plain words starting with a verb,",
  "saying what the agent will do differently (for example \"Check the player's view before finishing a",
  'scene"). `summary`: one to three short plain sentences about the same change. No file, skill, tool or',
  "camera names, no jargon.",
];
const DESCRIBE_REPLY = 'Reply with JSON only: {"title":"…","summary":["…"]}';

async function analyse(
  ctx: HarnessCtx,
  {
    engine,
    model,
    skill,
    failures,
    successes,
    stepBuffer,
  }: {
    engine: string;
    model?: string;
    skill: Skill;
    failures: ValidationTask[];
    successes: ValidationTask[];
    stepBuffer: Refusal[];
  },
): Promise<Proposal> {
  const systemPrompt = [
    "You improve an agent's skill file by proposing a few precise edits.",
    "",
    "Look for COMMON patterns across the trajectories, not one-offs. Propose only edits that would",
    "generalise to the next task. Do not duplicate advice the file already contains.",
    "",
    "The file serves every kind of game the studio builds. Never write a rule for one genre, sport or",
    "game (its players, pitch, referee or weapons): a lesson only this game needs is not an edit here.",
    "",
    "BE CONCRETE: quote the exact threshold, section name, or format. Vague rules do not change",
    "behaviour; specific numeric or structural rules do.",
    "",
    `Propose at most ${MAX_EDITS_PER_CALL} edits using exactly these operations:`,
    '  {"op":"append","text":"…"}',
    '  {"op":"insert_after","anchor":"exact existing substring","text":"…"}',
    '  {"op":"replace","anchor":"exact existing substring","text":"…"}',
    '  {"op":"delete","anchor":"exact existing substring"}',
    "Anchors must be exact substrings of the current file. Never edit inside a SLOW_UPDATE region.",
    "",
    "Also describe the change for the person who uses the app.",
    ...PLAIN_WORDS_RULES,
    "",
    'Reply with JSON only: {"edits":[…],"rationale":"…","title":"…","summary":["…"]}',
  ].join("\n");

  const userContent = [
    `SKILL FILE (${skill.slug}.md):`,
    "```markdown",
    skill.raw,
    "```",
    "",
    `FAILURES (${failures.length}):`,
    ...failures.map(
      (task) =>
        `- ${task.prompt}${task.evidence?.consoleErrors?.length ? ` [errors: ${task.evidence.consoleErrors.join("; ")}]` : ""}`,
    ),
    "",
    `SUCCESSES (${successes.length}):`,
    ...successes.map((task) => `- ${task.prompt}`),
    "",
    stepBuffer.length
      ? `ALREADY REJECTED — do not propose these again:\n${stepBuffer
          .slice(-REJECTED_EDITS_SHOWN)
          .map((entry) => `- ${JSON.stringify(entry.edits)} (${entry.why_rejected})`)
          .join("\n")}`
      : "",
    "",
    'Reply with JSON only: {"edits":[…],"rationale":"…","title":"…","summary":["…"]}',
  ]
    .filter(Boolean)
    .join("\n");

  const response = await ctx.call(HostMethod.EngineComplete, {
    engine,
    model,
    class: IMPROVEMENT_WORK,
    systemPrompt,
    stream: false,
    effort: LIGHT_EFFORT,
    messages: [{ role: "user", content: userContent }],
  });
  const parsed = parseVerdict(response.message?.content ?? "");
  const proposal: Proposal = {
    edits: Array.isArray(parsed.edits) ? parsed.edits : [],
    rationale: parsed.rationale ?? "",
    ...describedIn(parsed),
  };
  // A card without its own words reads "Change how Harness plans a build": ask once more for them.
  const described = Boolean(proposal.title) && proposal.summary.length > 0;
  const needsWords = proposal.edits.length > 0 && !described && !ctx.cancelled;
  if (!needsWords) return proposal;
  return { ...proposal, ...(await describeEdits(ctx, { engine, model, skill, proposal })) };
}

/** A reply's plain title and summary lines, bounded; empty where it wrote none. */
function describedIn(parsed: AnyRecord): Pick<Proposal, "title" | "summary"> {
  return {
    title: plainWords(parsed.title, PROPOSAL_TITLE_CHARS),
    summary: (Array.isArray(parsed.summary) ? parsed.summary : [parsed.summary])
      .map((line: unknown) => plainWords(line, CLIP_DETAIL))
      .filter(Boolean)
      .slice(0, SUMMARY_LINES),
  };
}

/** One light call for the plain words an analyst left out; nothing is changed when it writes none either. */
async function describeEdits(
  ctx: HarnessCtx,
  { engine, model, skill, proposal }: { engine: string; model?: string; skill: Skill; proposal: Proposal },
): Promise<Partial<Pick<Proposal, "title" | "summary">>> {
  const systemPrompt = [
    "You describe a proposed change to an agent's instructions for the person who uses the app.",
    ...PLAIN_WORDS_RULES,
    "",
    DESCRIBE_REPLY,
  ].join("\n");
  const userContent = [
    `PROPOSED EDITS to ${skill.slug}.md:`,
    JSON.stringify(proposal.edits, null, 2),
    "",
    proposal.rationale ? `WHY: ${proposal.rationale}` : "",
    "",
    DESCRIBE_REPLY,
  ]
    .filter(Boolean)
    .join("\n");
  const response = await ctx.call(HostMethod.EngineComplete, {
    engine,
    model,
    class: IMPROVEMENT_WORK,
    systemPrompt,
    stream: false,
    effort: LIGHT_EFFORT,
    messages: [{ role: "user", content: userContent }],
  });
  const words = describedIn(parseVerdict(response.message?.content ?? ""));
  return {
    ...(words.title ? { title: words.title } : {}),
    ...(words.summary.length ? { summary: words.summary } : {}),
  };
}

/** The user-facing description of a proposal: one bounded line of plain text, or nothing. */
function plainWords(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Failure-priority: edits that address a failure outrank polish. */
export function rankEdits<E extends SkillEdit>(edits: readonly E[]): E[] {
  const weight = (edit: E): number => {
    let score = 0;
    if (edit.priority === "failure") score += 100;
    if (edit.op === "replace" || edit.op === "insert_after") score += 10; // targeted beats appended
    if (typeof edit.text === "string" && /\d/.test(edit.text)) score += 5; // concrete beats vague
    if (edit.op === "append") score += 1;
    return score;
  };
  return [...edits].sort((a, b) => weight(b) - weight(a));
}

/** Deterministic split, every other task: the analyst sees `train`, the gate scores on `held`. */
export function splitTasks<T>(tasks: readonly T[]): { train: T[]; held: T[] } {
  return {
    train: tasks.filter((_task, index) => index % 2 === 0),
    held: tasks.filter((_task, index) => index % 2 === 1),
  };
}

/**
 * Blind pairwise gate. The judge sees the two skill *texts* unlabelled and decides which would
 * produce better behaviour on the held-out tasks. Tie ⇒ reject: the current skill keeps its place
 * unless the candidate clearly wins.
 */
async function gateCandidate(
  ctx: HarnessCtx,
  {
    engine,
    model,
    skill,
    candidateText,
    tasks,
  }: { engine: string; model?: string; skill: Skill; candidateText: string; tasks: ValidationTask[] },
): Promise<Gate> {
  if (tasks.length === 0) {
    return { accept: false, reason: "no held-out tasks to validate against", votes: "0/0" };
  }
  const systemPrompt = [
    "You are choosing between two versions of an agent's instructions.",
    "You do not know which is current. Judge only which would handle the listed tasks better.",
    "Prefer the one with concrete, checkable rules. Penalise vagueness, duplication and bloat.",
    "The instructions serve every kind of game: count a rule written for one genre, sport or game against its version.",
    "If they are equivalent, say tie.",
    "",
    'Reply with JSON only: {"pick":"A"|"B"|"tie","reason":"…"}',
  ].join("\n");

  const userContent = (candidateIsA: boolean): string =>
    [
      "TASKS THAT MUST BE HANDLED WELL:",
      ...tasks.map((task) => `- ${task.prompt}${task.success ? "" : " (this one went badly before)"}`),
      "",
      "VERSION A:",
      "```markdown",
      candidateIsA ? candidateText : skill.raw,
      "```",
      "",
      "VERSION B:",
      "```markdown",
      candidateIsA ? skill.raw : candidateText,
      "```",
      "",
      'Reply with JSON only: {"pick":"A"|"B"|"tie","reason":"…"}',
    ].join("\n");

  const votes = 3;
  const rubricSha = promptSha256(systemPrompt);
  // The candidate changes sides between votes, so a judge that favours one position cannot
  // hand it a unanimous win — one shuffle for all three votes asked the same question thrice.
  const firstIsA = Math.random() < 0.5;
  let forCandidate = 0;
  let lastReason = "";
  for (let i = 0; i < votes; i++) {
    // A cancelled pass must not keep burning judge calls; an unfinished vote rejects (safe).
    if (ctx.cancelled) return { accept: false, reason: "pass stopped by the user", votes: `${forCandidate}/${votes}` };
    const candidateIsA = i % 2 === 0 ? firstIsA : !firstIsA;
    const candidateLetter = candidateIsA ? BallotLetter.A : BallotLetter.B;
    const response = await ctx.call(HostMethod.EngineComplete, {
      engine,
      model,
      class: IMPROVEMENT_WORK,
      systemPrompt,
      stream: false,
      effort: LIGHT_EFFORT,
      messages: [{ role: "user", content: userContent(candidateIsA) }],
      provenance: { role: CompletionRole.SkilloptGate, promptSha256: rubricSha },
    });
    const parsed = parseVerdict(response.message?.content ?? "");
    lastReason = parsed.reason ?? lastReason;
    if (parsed.pick === candidateLetter) forCandidate++;
  }
  const accept = forCandidate > votes / 2;
  return {
    accept,
    votes: `${forCandidate}/${votes} for the candidate`,
    reason: accept ? lastReason : `not a strict improvement (${forCandidate}/${votes})`,
  };
}

/**
 * Staged proposals wait in `skillopt_staged`: the host applies them (snapshot first, logged,
 * undoable) — at once when the user's switches allow, after a review otherwise.
 */
async function stageProposal(ctx: HarnessCtx, skill: Skill, text: string, entry: ProposalEntry): Promise<void> {
  const staged = ((await ctx.call(HostMethod.ArtifactRead, { artifactId: STAGED })) ?? []) as AnyRecord[];
  staged.push({
    skill: skill.slug,
    file: `skills/${skill.slug}.md`,
    proposedText: text,
    currentText: skill.raw,
    gate: entry.gate,
    edits: entry.edits,
    rationale: entry.rationale,
    title: entry.title,
    summary: entry.summary,
    at: new Date().toISOString(),
  });
  await ctx.call(HostMethod.ArtifactWrite, { artifactId: STAGED, value: staged });
  await ctx.call(HostMethod.EventsAppend, {
    batch: [{ type: EventKind.Custom, event_type: RunEvent.SkilloptStaged, payload: entry }],
  });
  ctx.notify("skillopt.staged", { skill: skill.slug, gate: entry.gate });
}
