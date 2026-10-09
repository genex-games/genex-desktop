/**
 * The judge that plays. A fresh, blind session with only the `computer` tool, on a seeded stepped
 * clock, sent into a build to answer a few yes/no questions by playing — and, given a quest, to
 * reach a goal the studio checks in the game's own state after every move.
 *
 * What makes its "yes" worth more than a playtester's: with a quest, a yes stands only when the
 * studio verified the goal (`trace.reachedAt`) and the frame the judge cites is not blank. A yes
 * without that is incomplete — the model's word, never a pass. No window is no measurement, never
 * a failure.
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
import type { Quest } from "./quest.ts";
import { readTraceRows, type TraceRow } from "./routes.ts";
import { CheckKind, CheckWeight, type Check } from "./spec.ts";
import { unmeasured, type CheckResult } from "./checks.ts";
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
/** A lit fraction as a tool answer states it. */
const LIT_IN_ANSWER = /litFraction (\d+(?:\.\d+)?)/;

/** Why a question came back without a measurement, in the board's words. */
const MESSAGE = {
  noWindow: "no window for a judge that plays — unmeasured, not failed",
  noComputer: "this studio cannot hand a direct engine the computer tool — unmeasured, not failed",
  notAnswered: "the judge did not answer this question",
  notReached: "the judge said yes, but the studio never saw the goal reached — incomplete, the model's word only",
  blankFrame: "the judge said yes, but the frame it rests on is blank or unreadable — incomplete",
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
  quest?: Quest | null;
  maxActions?: number;
  deadline?: number | null;
  labelPrefix?: string | null;
  iteration?: number;
  entry?: string;
  /** The facet the session is filed under (`facetId`). */
  facetId?: string;
}

/** What it came back with: the board's results, what they rest on, the trace, and its record. */
export interface HandsOnOutcome {
  results: CheckResult[];
  objective: InteractionObjective;
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
  lastAnswer: string;
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

/** What a yes with a quest must rest on: the move the studio verified the goal after, and a lit frame. */
export interface QuestProof {
  reachedAt: number | null;
  /** Whether the frame the judge's answer rests on is lit; null when it could not be read. */
  frameLit: boolean | null;
}

/**
 * The pass rule. Without a quest the results stand as the model gave them, on its word. With one,
 * a pass stands only when the studio verified the goal and the frame it rests on is not blank;
 * any other pass is incomplete. A "no" stands either way: a judge that failed to reach the goal
 * is not overruled by the studio having seen it.
 */
export function questRuled(
  results: readonly CheckResult[],
  quest: Quest | null | undefined,
  proof: QuestProof,
): { results: CheckResult[]; objective: InteractionObjective } {
  if (!quest) return { results: [...results], objective: InteractionObjective.ModelSaid };
  const reached = proof.reachedAt !== null;
  const verified = reached && proof.frameLit === true;
  const why = reached ? MESSAGE.blankFrame : MESSAGE.notReached;
  const ruled = results.map((result) =>
    result.pass === true && !verified
      ? { ...unmeasured(result, why), answer: result.answer, note: result.note }
      : result,
  );
  return { results: ruled, objective: verified ? InteractionObjective.StudioVerified : InteractionObjective.ModelSaid };
}

/** Every question unmeasured, for a judge that never got to play. */
function nothingMeasured(options: HandsOnOptions, questions: readonly Check[], why: string): HandsOnOutcome {
  return {
    results: questions.map((check) => unmeasured(check, why)),
    objective: InteractionObjective.ModelSaid,
    trace: null,
    frames: {},
    report: { facetId: options.facetId ?? "integration", iteration: options.iteration ?? 0, actions: 0, report: why },
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
    facetId: facetId ?? "integration",
    iteration: iteration ?? 0,
    ...(entry ? { entry } : {}),
    // No setup script: a judge reaches the state it is asked about by playing, and the route it
    // played is the one a later build is replayed along.
    setup: { begin: false },
    label: "judge",
    role: PlayRole.Judge,
    maxActions,
    pacing: PlayPacing.Stepped,
    ...(quest ? { quest } : {}),
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
  return { actions: result.turns ?? 0, transcript: result.summary ?? "", trace: result.trace ?? null, lastAnswer: "" };
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

/** The frames the judge cited, in the order it wrote them: the last is what its answers rest on. */
export function citedFrames(raw: AnyRecord | null | undefined): string[] {
  const answers = isRecord(raw?.answers) ? Object.values(raw.answers) : [];
  return answers.flatMap(framesOfAnswer);
}

/** The lit fraction a tool answer stated for the frame it names, or null. */
function litInAnswer(answer: string, frame: string | null): number | null {
  if (frame && !answer.includes(frame.replace(/\.jpg$/, ""))) return null;
  const found = LIT_IN_ANSWER.exec(answer);
  return found ? Number(found[1]) : null;
}

/** The file a cited frame name stands for in the trace; a citation may drop the extension. */
function frameFile(rows: readonly TraceRow[], cited: string): string | null {
  const stem = cited.replace(/\.jpg$/, "");
  return rows.find((row) => row.frame && path.basename(row.frame).startsWith(stem))?.frame ?? null;
}

/** The file of the frame the answers rest on: the last cited one, else the session's last frame. */
function restingFrame(rows: readonly TraceRow[], cited: readonly string[]): string | null {
  const last = cited.at(-1);
  if (last) return frameFile(rows, last);
  return rows.filter((row) => row.frame).at(-1)?.frame ?? null;
}

/** Is the frame the judge's answers rest on lit? Null when no frame can be read. */
async function frameLit(ctx: HarnessCtx, played: Played, handle: string): Promise<boolean | null> {
  const cited = citedFrames(played.raw);
  const stated = litInAnswer(played.session.lastAnswer, cited.at(-1) ?? null);
  if (stated !== null) return stated >= BLANK_LIT_FRACTION;
  const file = restingFrame(played.rows, cited);
  if (!file) return null;
  const read = await ctx.call(HostMethod.PreviewStatsOf, { path: file, handle }).catch(() => null);
  const lit = read?.stats?.litFraction;
  return typeof lit === "number" ? lit >= BLANK_LIT_FRACTION : null;
}

/** Each question's cited frames, as files of the session's trace. */
function citedFiles(played: Played, questions: readonly Check[]): Record<string, string[]> {
  const answers = isRecord(played.raw?.answers) ? played.raw.answers : {};
  const files: Record<string, string[]> = {};
  for (const check of questions) {
    const found = framesOfAnswer(answers[check.id]).map((name) => frameFile(played.rows, name));
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

/** The record a session leaves: its answers, what they rest on, and its report. */
function judgeReport(options: HandsOnOptions, played: Played, ruled: HandsOnOutcome): AnyRecord {
  const { session, raw } = played;
  return {
    facetId: options.facetId ?? "integration",
    iteration: options.iteration ?? 0,
    role: PlayRole.Judge,
    actions: session.actions,
    quest: options.quest ?? null,
    objective: ruled.objective,
    trace: session.trace,
    answers: Object.fromEntries(
      ruled.results.map((r) => [
        r.id,
        { pass: r.pass, answer: r.answer ?? null, note: r.note ?? "", reason: r.reason, frames: ruled.frames[r.id] },
      ]),
    ),
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
  const session = await play(ctx, options, questions, handle);
  if (!session) return nothingMeasured(options, questions, MESSAGE.noComputer);
  const played: Played = {
    session,
    raw: session.transcript ? parseVerdict(session.transcript) : null,
    rows: await readTraceRows(session.trace?.path),
  };
  const lit = options.quest ? await frameLit(ctx, played, handle) : null;
  const proof = { reachedAt: session.trace?.reachedAt ?? null, frameLit: lit };
  const ruled = questRuled(handsOnResults(questions, played.raw), options.quest, proof);
  const outcome: HandsOnOutcome = { ...ruled, trace: session.trace, frames: citedFiles(played, questions), report: {} };
  outcome.report = judgeReport(options, played, outcome);
  await fileReport(ctx, options, outcome.report);
  return outcome;
}

/** Write what a judge that played established to the run's record, once per question. */
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
      objective: outcome.objective,
      trace: outcome.trace?.path ?? null,
    });
  }
}
