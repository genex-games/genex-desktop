/**
 * The judge that plays. A fresh, blind session with only the `computer` tool, on a seeded stepped
 * clock, sent into a build to answer a few yes/no questions by playing — and, given a quest, to
 * reach a goal the studio checks in the game's own state after every move.
 *
 * What makes its "yes" worth more than a playtester's: a quest is set for ONE question (its
 * `checkId`, or the only question asked). That question's yes stands only when the studio verified
 * the goal (`trace.reachedAt`) and the frame the judge cites for it was taken at or after that move
 * and is not blank — read from the frame file itself, never from the words of a tool answer. A yes
 * without that is incomplete. Every other answer of the session is the model's word, ruled as a
 * playtester's is. No window is no measurement, never a failure.
 *
 * Two transports, like the playtester's: a session engine is delegated with a `judge` grant; a
 * direct engine plays through `preview.computer` in the harness's own loop (computer-loop.ts).
 *
 * A new module: it reaches playtester.ts through a namespace import with a local fallback, so a
 * kept older playtester.ts the agent edited never stops it loading.
 */
import path from "node:path";
import { MIN_DELEGATE_TIMEOUT_MS } from "./config.ts";
import { EngineId, modelOn, roleEffort, roleEngine, RoleKey, supportsSessions } from "./model-roles.ts";
import * as playtester from "./playtester.ts";
import { judgePrompt, parseVerdict } from "./judge.ts";
import { CompletionRole } from "./judge-provenance.ts";
import { HostMethod } from "./host-methods.ts";
import { describeComputer, PlayPacing, PlayRole, playWithComputer, type ComputerGrant } from "./computer-loop.ts";
import { HANDS_ON_RUBRIC_FALLBACK, handsOnBrief } from "./hands-on-prompts.ts";
import { InteractionObjective, InteractionSource } from "./interaction-words.ts";
import { appendInteraction, interactionStatus } from "./interaction-evidence.ts";
import { questGrant, type Quest } from "./quest.ts";
import { readTraceRows, type TraceRow } from "./routes.ts";
import { CheckKind, CheckWeight, type Check } from "./spec.ts";
import { unmeasured, type CheckResult } from "./checks.ts";
import { FacetRole } from "./facet/state.ts";
import { MINUTE_MS } from "./time.ts";
import { isRecord } from "./json.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { ComputerTraceSummary, EngineDescriptor } from "../types/host-api.d.ts";

/** The moves a judge that plays may make unless its caller says otherwise. */
export const HANDS_ON_MAX_ACTIONS = 12;
/** The longest a judge's session may take. */
const HANDS_ON_MAX_MS = 10 * MINUTE_MS;
/** Below this lit fraction a frame is blank: it shows nothing a yes could rest on (evidence.ts's black frame). */
const BLANK_LIT_FRACTION = 0.005;
/** How much of the report and the transcript a record keeps. */
const REPORT_CHARS = 4_000;
const TRANSCRIPT_CHARS = 2_000;
/** A frame name as a judge cites it and the session saves it: `s<N>_…`. */
const FRAME_NAME = /^s\d+_[\w.-]*$/;
/** The picture a session saves a frame as; a citation may leave it off. */
const FRAME_EXTENSION = /\.(jpe?g|png)$/i;

/** Why a question came back without a measurement, in the board's words. */
const MESSAGE = {
  noWindow: "no window for a judge that plays — unmeasured, not failed",
  noComputer: "this studio cannot hand a direct engine the computer tool — unmeasured, not failed",
  notAnswered: "the judge did not answer this question",
  notReached: "the judge said yes, but the studio never saw the goal reached — incomplete, the model's word only",
  blankFrame: "the judge said yes, but the frame it rests on is blank or unreadable — incomplete",
  earlyFrame:
    "the judge said yes, but the frame it rests on was taken before the studio saw the goal reached — incomplete",
  answered: (answer: string, note: string) => `judge answered ${answer}${note ? `: ${note}` : ""}`,
} as const;

/** What a judge that plays is handed. */
export interface HandsOnOptions {
  run: Run;
  /** The build's folder: the game folder, or a build under this run's scratch. */
  root: string;
  /** A leased window; without one nothing is measured. */
  handle: string | null | undefined;
  questions: readonly Check[];
  /** The goal to reach, set for one question (`checkId`, or the only one asked). */
  quest?: Quest | null;
  maxActions?: number;
  deadline?: number | null;
  labelPrefix?: string | null;
  iteration?: number;
  entry?: string;
  /** The facet the session is filed under (`facetId`). */
  facetId?: string;
}

/** What it came back with: the board's results, what each rests on, the trace, and its record. */
export interface HandsOnOutcome {
  results: CheckResult[];
  /** What the answer to the quest's own question rests on; the model's word without one. */
  objective: InteractionObjective;
  /** What each answer rests on, by check id: studio-verified only for the quest's own question. */
  objectives: Record<string, InteractionObjective>;
  trace: ComputerTraceSummary | null;
  /** Each question's cited frames, as files of the session's trace. */
  frames: Record<string, string[]>;
  report: AnyRecord;
}

/** What a session came back with, on either transport. */
interface Session {
  actions: number;
  transcript: string;
  trace: ComputerTraceSummary | null;
}

/** Is the judge that plays on for this run? On unless the run says `handsOnJudges: false`. */
export function handsOnJudgesOn(run: Run | AnyRecord | null | undefined): boolean {
  return run?.handsOnJudges !== false && run?.budgets?.handsOnJudges !== false;
}

/** A yes or a no, or null for anything else. */
function yesOrNo(answer: unknown): "yes" | "no" | null {
  return answer === "yes" || answer === "no" ? answer : null;
}

/** One answer as a play result, for a kept playtester.ts that has no `playResults`. */
function localPlayResult(check: Check, entry: AnyRecord | undefined): CheckResult {
  const answer = yesOrNo(entry?.answer);
  if (!answer) return unmeasured(check, MESSAGE.notAnswered, { answer: null, note: "" });
  const pass = answer === (check.expect === "no" ? "no" : "yes");
  const note = typeof entry?.note === "string" ? entry.note : "";
  return {
    id: check.id,
    kind: CheckKind.Play,
    weight: check.weight ?? CheckWeight.Normal,
    pass,
    reason: pass ? "" : MESSAGE.answered(answer, note),
    answer,
    note,
  };
}

/** The judge's JSON as play results: the playtester's own reading when it has one. */
export function handsOnResults(questions: readonly Check[], raw: AnyRecord | null | undefined): CheckResult[] {
  if (typeof playtester.playResults === "function") return playtester.playResults(questions, raw);
  const answers = isRecord(raw?.answers) ? raw.answers : {};
  return questions.map((check) => localPlayResult(check, answers[check.id]));
}

/**
 * The question a quest was set for: the one it names when it is asked, else the only question
 * asked (a director's `goal_state` asks one); null when it is neither, and then no answer rests
 * on the goal.
 */
export function tiedCheckId(quest: Quest | null | undefined, questions: readonly Check[]): string | null {
  if (!quest) return null;
  if (quest.checkId) return questions.some((check) => check.id === quest.checkId) ? quest.checkId : null;
  return questions.length === 1 ? (questions[0]?.id ?? null) : null;
}

/** The quest with the question it was set for resolved, or null without one. */
function tiedQuest(quest: Quest | null | undefined, questions: readonly Check[]): Quest | null {
  if (!quest) return null;
  const checkId = tiedCheckId(quest, questions);
  return { ...questGrant(quest), ...(checkId ? { checkId } : {}) };
}

/** What the quest's own yes must rest on: the move the studio verified the goal after, and a lit frame from then on. */
export interface QuestProof {
  reachedAt: number | null;
  /** Whether the frame that yes rests on is lit, read from the frame file; null when it could not be read. */
  frameLit: boolean | null;
  /** The move (the trace row's `i`) that saved that frame; null when no frame was found. */
  frameAt: number | null;
}

/** Why the quest's own yes is not studio-verified, or null when it is. */
function unproven(proof: QuestProof): string | null {
  if (proof.reachedAt === null) return MESSAGE.notReached;
  if (proof.frameAt === null) return MESSAGE.blankFrame;
  if (proof.frameAt < proof.reachedAt) return MESSAGE.earlyFrame;
  return proof.frameLit === true ? null : MESSAGE.blankFrame;
}

/**
 * The pass rule. Every answer but the quest's own stands as the model gave it, on its word. The
 * quest's own yes stands only when the studio verified the goal and the frame it rests on is lit
 * and from then on; any other yes there is incomplete. A "no" stands either way: a judge that
 * failed to reach the goal is not overruled by the studio having seen it.
 */
export function questRuled(
  results: readonly CheckResult[],
  quest: Quest | null | undefined,
  proof: QuestProof,
): { results: CheckResult[]; objective: InteractionObjective; objectives: Record<string, InteractionObjective> } {
  const tied = quest?.checkId ?? null;
  const why = tied ? unproven(proof) : null;
  const objectives: Record<string, InteractionObjective> = {};
  const ruled = results.map((result) => {
    const own = result.id === tied && result.pass === true;
    objectives[result.id] = own && why === null ? InteractionObjective.StudioVerified : InteractionObjective.ModelSaid;
    if (!own || why === null) return result;
    return { ...unmeasured(result, why), answer: result.answer, note: result.note };
  });
  const objective = (tied && objectives[tied]) || InteractionObjective.ModelSaid;
  return { results: ruled, objective, objectives };
}

/** Every answer as the model's word: what a session that never played rests on. */
function modelSaidAll(questions: readonly Check[]): Record<string, InteractionObjective> {
  return Object.fromEntries(questions.map((check) => [check.id, InteractionObjective.ModelSaid]));
}

/** Every question unmeasured, for a judge that never got to play. */
function nothingMeasured(options: HandsOnOptions, questions: readonly Check[], why: string): HandsOnOutcome {
  return {
    results: questions.map((check) => unmeasured(check, why)),
    objective: InteractionObjective.ModelSaid,
    objectives: modelSaidAll(questions),
    trace: null,
    frames: {},
    report: {
      facetId: options.facetId ?? FacetRole.Integration,
      iteration: options.iteration ?? 0,
      actions: 0,
      report: why,
    },
  };
}

/** Where a judge that plays sits: the engine, whether it holds a session there, and the model. */
interface Seat {
  engineId: string;
  delegated: boolean;
  model: string | undefined;
}

/** Can this model play: a session engine's always can; a local one must call tools and see images. */
function canPlay(engine: EngineDescriptor | undefined, model: string | undefined): boolean {
  if (!engine) return false;
  if (supportsSessions(engine)) return true;
  const row = engine.models.find((m) => m.id === (model ?? engine.defaultModel));
  return Boolean(row?.supportsTools && row.supportsVision);
}

/** The playtester's seat rule: the reviewers' engine and model when it can play, else the run's own. */
async function judgeSeat(ctx: HarnessCtx, run: Run): Promise<Seat> {
  const described = await ctx.call(HostMethod.EngineDescribe, {});
  const find = (id: string): EngineDescriptor | undefined => described.find((e) => e.id === id);
  const judgeEngine = roleEngine(run, RoleKey.Judge);
  const judgeModel = run.judgeModel ?? modelOn(run, judgeEngine);
  const judge = find(judgeEngine);
  if (canPlay(judge, judgeModel))
    return { engineId: judgeEngine, delegated: supportsSessions(judge), model: judgeModel };
  const own = run.engine ?? EngineId.Ollama;
  return { engineId: own, delegated: supportsSessions(find(own)), model: modelOn(run, own) };
}

/** The grant a judge plays under: blind, stepped, on the game's own first screen, with its goal and budget. */
function judgeGrant(options: HandsOnOptions, handle: string, maxActions: number): ComputerGrant {
  const { run, root, entry, quest, iteration, facetId } = options;
  return {
    project: run.project,
    root,
    handle,
    runId: run.runId,
    facetId: facetId ?? FacetRole.Integration,
    iteration: iteration ?? 0,
    ...(entry ? { entry } : {}),
    // No setup script: a judge reaches the state it is asked about by playing, and the route it
    // played is the one a later build is replayed along.
    setup: { begin: false },
    label: PlayRole.Judge,
    role: PlayRole.Judge,
    maxActions,
    pacing: PlayPacing.Stepped,
    ...(quest ? { quest: questGrant(quest) } : {}),
  };
}

/** The delegated session: a blind judge with only the computer, on the seat's engine. */
async function delegatedJudge(
  ctx: HarnessCtx,
  options: HandsOnOptions,
  grant: ComputerGrant,
  seat: Seat,
  prompt: string,
): Promise<Session> {
  const { run, deadline, maxActions = HANDS_ON_MAX_ACTIONS } = options;
  const timeoutMs = Math.max(
    MIN_DELEGATE_TIMEOUT_MS,
    Math.min(HANDS_ON_MAX_MS, (deadline ?? Date.now() + HANDS_ON_MAX_MS) - Date.now()),
  );
  const result = await ctx.call(HostMethod.EngineDelegate, {
    engine: seat.engineId,
    prompt,
    project: run.project,
    cwd: options.root,
    ...(seat.model ? { model: seat.model } : {}),
    effort: roleEffort(run, RoleKey.Judge),
    timeoutMs,
    maxTurns: maxActions * 2 + 6,
    playtest: grant,
    readOnly: true,
  });
  return { actions: result.turns ?? 0, transcript: result.summary ?? "", trace: result.trace ?? null };
}

/** The direct session: the computer through `preview.computer`, in the harness's loop; null when the host has none. */
async function directJudge(
  ctx: HarnessCtx,
  options: HandsOnOptions,
  grant: ComputerGrant,
  seat: Seat,
  words: { system: string; brief: string },
): Promise<Session | null> {
  const tool = await describeComputer(ctx, grant);
  if (!tool) return null;
  return playWithComputer(ctx, {
    engineId: seat.engineId,
    model: seat.model,
    system: words.system,
    brief: words.brief,
    grant,
    tool,
    maxActions: options.maxActions ?? HANDS_ON_MAX_ACTIONS,
    deadline: options.deadline ?? null,
    role: CompletionRole.Judge,
    runId: options.run.runId,
  });
}

/** The frame names one answer cites, as the session saved them (`s<N>_…`). */
function framesOfAnswer(entry: unknown): string[] {
  const frames = isRecord(entry) && Array.isArray(entry.frames) ? entry.frames : [];
  return frames.map((frame) => path.basename(String(frame))).filter((name) => FRAME_NAME.test(name));
}

/** The frames the judge cited, in the order it wrote them. */
export function citedFrames(raw: AnyRecord | null | undefined): string[] {
  const answers = isRecord(raw?.answers) ? Object.values(raw.answers) : [];
  return answers.flatMap(framesOfAnswer);
}

/** A frame file's name without its picture extension. */
function frameStem(name: string): string {
  return name.replace(FRAME_EXTENSION, "");
}

/** The trace row that saved a cited frame; a citation may leave the extension off. */
function rowOfFrame(rows: readonly TraceRow[], cited: string): TraceRow | null {
  const stem = frameStem(cited);
  return rows.find((row) => row.frame && frameStem(path.basename(row.frame)) === stem) ?? null;
}

/** The row an answer rests on: the last frame it cited, else the session's last frame. */
function restingRow(rows: readonly TraceRow[], cited: readonly string[]): TraceRow | null {
  const last = cited.at(-1);
  if (last) return rowOfFrame(rows, last);
  return rows.filter((row) => row.frame).at(-1) ?? null;
}

/** The frame the quest's own answer rests on: the move that saved it, and whether its pixels are lit. */
async function frameProof(
  ctx: HarnessCtx,
  played: Played,
  handle: string,
  checkId: string,
): Promise<Pick<QuestProof, "frameLit" | "frameAt">> {
  const answers = isRecord(played.raw?.answers) ? played.raw.answers : {};
  const row = restingRow(played.rows, framesOfAnswer(answers[checkId]));
  if (!row?.frame) return { frameLit: null, frameAt: null };
  const read = await ctx.call(HostMethod.PreviewStatsOf, { path: row.frame, handle }).catch(() => null);
  const lit = read?.stats?.litFraction;
  return { frameLit: typeof lit === "number" ? lit >= BLANK_LIT_FRACTION : null, frameAt: row.i };
}

/** What the quest's own answer rests on; nothing to read without a quest set for a question. */
async function questProof(ctx: HarnessCtx, played: Played, handle: string, quest: Quest | null): Promise<QuestProof> {
  const reachedAt = played.session.trace?.reachedAt ?? null;
  if (!quest?.checkId) return { reachedAt, frameLit: null, frameAt: null };
  return { reachedAt, ...(await frameProof(ctx, played, handle, quest.checkId)) };
}

/** Each question's cited frames, as files of the session's trace. */
function citedFiles(played: Played, questions: readonly Check[]): Record<string, string[]> {
  const answers = isRecord(played.raw?.answers) ? played.raw.answers : {};
  const files: Record<string, string[]> = {};
  for (const check of questions) {
    const found = framesOfAnswer(answers[check.id]).map((name) => rowOfFrame(played.rows, name)?.frame ?? null);
    files[check.id] = found.filter((file): file is string => file !== null);
  }
  return files;
}

/** A finished session with what was read from it: the judge's JSON and the trace's rows. */
interface Played {
  session: Session;
  raw: AnyRecord | null;
  rows: TraceRow[];
}

/** The record a session leaves: its answers, what each rests on, and its report. */
function judgeReport(options: HandsOnOptions, played: Played, ruled: HandsOnOutcome, quest: Quest | null): AnyRecord {
  const { session, raw } = played;
  const answer = (r: CheckResult) => ({
    pass: r.pass,
    answer: r.answer ?? null,
    note: r.note ?? "",
    reason: r.reason,
    frames: ruled.frames[r.id],
    objective: ruled.objectives[r.id],
  });
  return {
    facetId: options.facetId ?? FacetRole.Integration,
    iteration: options.iteration ?? 0,
    role: PlayRole.Judge,
    actions: session.actions,
    quest,
    objective: ruled.objective,
    trace: session.trace,
    answers: Object.fromEntries(ruled.results.map((r) => [r.id, answer(r)])),
    report:
      typeof raw?.report === "string"
        ? raw.report.slice(0, REPORT_CHARS)
        : session.transcript.slice(0, TRANSCRIPT_CHARS),
  };
}

/** Play the session on the seat's transport; null when the host cannot run a direct one. */
async function play(
  ctx: HarnessCtx,
  options: HandsOnOptions,
  questions: readonly Check[],
  handle: string,
): Promise<Session | null> {
  const maxActions = options.maxActions ?? HANDS_ON_MAX_ACTIONS;
  const system = await judgePrompt(ctx, "hands-on.md", HANDS_ON_RUBRIC_FALLBACK);
  const brief = handsOnBrief({ run: options.run, questions, quest: options.quest ?? null, maxActions });
  const seat = await judgeSeat(ctx, options.run);
  const grant = judgeGrant(options, handle, maxActions);
  if (seat.delegated) return delegatedJudge(ctx, options, grant, seat, `${system}\n\n${brief}`);
  return directJudge(ctx, options, grant, seat, { system, brief });
}

/** Keep the session's record with the run, and say it happened. */
async function fileReport(ctx: HarnessCtx, options: HandsOnOptions, report: AnyRecord): Promise<void> {
  if (options.labelPrefix) {
    await ctx
      .call(HostMethod.RunArtifact, {
        runId: options.run.runId,
        name: `${options.labelPrefix}/judge.json`,
        base64: Buffer.from(JSON.stringify(report, null, 2)).toString("base64"),
      })
      .catch(() => {});
  }
  ctx.notify("judge.playtest", report);
}

/**
 * Send a judge that plays into a build and answer `questions` from what it did. Never throws for
 * want of a window or a computer: those questions come back unmeasured.
 */
export async function runHandsOnJudge(ctx: HarnessCtx, options: HandsOnOptions): Promise<HandsOnOutcome> {
  const questions = options.questions.filter((check) => check.ask);
  const { handle } = options;
  if (!handle) return nothingMeasured(options, questions, MESSAGE.noWindow);
  if (questions.length === 0) return nothingMeasured(options, questions, MESSAGE.notAnswered);
  const quest = tiedQuest(options.quest, questions);
  const session = await play(ctx, { ...options, quest }, questions, handle);
  if (!session) return nothingMeasured(options, questions, MESSAGE.noComputer);
  const played: Played = {
    session,
    raw: session.transcript ? parseVerdict(session.transcript) : null,
    rows: await readTraceRows(session.trace?.path),
  };
  const proof = await questProof(ctx, played, handle, quest);
  const ruled = questRuled(handsOnResults(questions, played.raw), quest, proof);
  const outcome: HandsOnOutcome = { ...ruled, trace: session.trace, frames: citedFiles(played, questions), report: {} };
  outcome.report = judgeReport(options, played, outcome, quest);
  await fileReport(ctx, options, outcome.report);
  return outcome;
}

/** Write what a judge that played established to the run's record, once per question, on what each rests on. */
export async function recordHandsOn(
  ctx: HarnessCtx,
  run: Run,
  outcome: HandsOnOutcome,
  questions: readonly Check[],
): Promise<void> {
  for (const result of outcome.results) {
    const ask = questions.find((check) => check.id === result.id)?.ask ?? result.id;
    await appendInteraction(ctx, run.runId, {
      head: null,
      label: ask,
      status: interactionStatus(result.pass),
      note: result.note || result.reason || null,
      source: InteractionSource.HandsOnJudge,
      objective: outcome.objectives[result.id] ?? InteractionObjective.ModelSaid,
      trace: outcome.trace?.path ?? null,
    });
  }
}
