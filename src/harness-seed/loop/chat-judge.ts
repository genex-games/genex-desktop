/**
 * A judge that plays, asked for by the chat's own session after a change (`judge_play`, the host's
 * `chat_judge` dispatch): the same blind judge a Loop's build uses (`runHandsOnJudge`), on a hidden
 * window of its own, in the game folder as the change left it, held to the goal state the session
 * names. The studio checks that state after every move; a yes it saw reached is studio-verified.
 * The session may name one of the judges the game's engine plugin declares (`judge`, checked by the
 * host before it forwards the call): it plays as that judge, with its brief, players and probe.
 *
 * It records nothing itself: the host writes the outcome to the chat, keeping "verified by the
 * studio" only for a trace the studio itself saw reach the goal. Never throws: a refusal, or a
 * window that never came, is an answer with nothing measured.
 *
 * A module of its own: an agent-edited copy of an older sibling never shadows these names.
 */
import { WINDOW_RETRIES_MS } from "./config.ts";
import { withLease } from "./evidence.ts";
import { servesEngineJudges } from "./engine-judges.ts";
import * as handsOn from "./hands-on-judge.ts";
import { HostMethod } from "./host-methods.ts";
import { InteractionStatus, interactionStatus } from "./interaction-evidence.ts";
import { InteractionObjective } from "./interaction-words.ts";
import { parseGoalState, questId, type Quest } from "./quest.ts";
import { CheckKind, CheckWeight, type Check } from "./spec.ts";
import { MINUTE_MS } from "./time.ts";
import type { HarnessCtx, Run } from "../types/harness.d.ts";
import type { DispatchAction } from "../types/host-api.d.ts";

/** The capability main.ts claims for it: the app's `HarnessCapability.ChatJudge`. */
export const CHAT_JUDGE_CAPABILITY = "chat-judge";

/**
 * Does the judge this depends on serve a chat's check? A kept older `hands-on-judge.ts` does not,
 * and the chat's judge is then never claimed.
 */
export function servesChatJudge(parts: readonly Readonly<Record<string, unknown>>[] = [handsOn]): boolean {
  return parts.every((part) => part.SERVES_CHAT_JUDGE === true);
}

/** How long a chat's judge may play: a director's playtest's default. */
const CHAT_JUDGE_MS = 5 * MINUTE_MS;
/** The longest question a judge is handed, in characters. */
const MAX_ASK_CHARS = 500;
/** The one question's id, as the judge answers it. */
const CHECK_ID = "chat-judge";
/** The facet a chat's judge files its frames under. */
const FACET = "chat-judge";
/** Who put the question on the board: the chat's own session. */
const ORIGIN = "chat";
/** The leased window's name in the window strip. */
const WINDOW_LABEL = "judge:chat";

/** What the session is told when nothing was played, and why. */
const MESSAGE = {
  noAsk: "judge_play needs ask: one yes/no question the judge can settle by playing",
  goalState: (why: string) => `goal_state: ${why}`,
  noWindow: (why: string) => `No hidden window is free to play in right now: ${why}. Try again in a minute.`,
  noEngineJudges: (id: string) =>
    `this harness's judge can't play as the game's "${id}" judge (its judge module is an older copy): leave judge out and a plain judge plays`,
} as const;

/** A chat's call for a judge, as the host forwards it. */
export type ChatJudgeAsk = Extract<DispatchAction, { type: "chat_judge" }>;

/** What the judge came back with: its answer, what it rests on, its trace, or why nothing was played. */
export interface ChatJudgeAnswer {
  status: InteractionStatus;
  answer: "yes" | "no" | null;
  note: string;
  objective: InteractionObjective;
  /** The session's trace (`trace.jsonl`), when it played. */
  trace: string | null;
  /** Why nothing was played: a question or goal it could not take, or no window. */
  refusal?: string;
}

/** Only what tests may change: how long to wait for a window between tries. */
export interface ChatJudgeOptions {
  retriesMs?: readonly number[];
}

/** An answer with nothing measured, saying why. */
function refused(refusal: string): ChatJudgeAnswer {
  return {
    status: InteractionStatus.Incomplete,
    answer: null,
    note: "",
    objective: InteractionObjective.ModelSaid,
    trace: null,
    refusal,
  };
}

/**
 * What the judge needs of a run, for a chat's check: the game, the chat's engine and model to play
 * with, and the question as the goal its brief names. No run id: its frames are filed ad hoc.
 */
function chatRun(ask: ChatJudgeAsk, question: string): Run {
  return {
    runId: "",
    goal: question,
    project: ask.project,
    reference: { name: "", shots: [] },
    budgets: { wallClockMs: CHAT_JUDGE_MS },
    engine: ask.engine,
    judgeEngine: ask.engine,
    ...(ask.model ? { model: ask.model, judgeModel: ask.model } : {}),
    ...(ask.effort ? { roles: { efforts: { judge: ask.effort } } } : {}),
  };
}

/** The goal the judge plays to, or why the goal state cannot be one; null when none was named. */
function questOf(question: string, goalState: string | undefined): Quest | { error: string } | null {
  const until = parseGoalState(goalState ?? "");
  if (until === null) return null;
  if ("error" in until) return { error: MESSAGE.goalState(until.error) };
  return { id: questId(question, "goal"), until: until.until };
}

/** One blind judge's play of the chat's game, on a hidden window, answered for the host to record. */
export async function judgeFromChat(
  ctx: HarnessCtx,
  ask: ChatJudgeAsk,
  options: ChatJudgeOptions = {},
): Promise<ChatJudgeAnswer> {
  const question = ask.ask.trim().slice(0, MAX_ASK_CHARS);
  if (!question) return refused(MESSAGE.noAsk);
  const quest = questOf(question, ask.goalState);
  if (quest && "error" in quest) return refused(quest.error);
  const judge = ask.judge?.trim() ?? "";
  // A kept older judge would play a named judge as a plain one while the chat records it as that judge.
  if (judge && !servesEngineJudges()) return refused(MESSAGE.noEngineJudges(judge));
  const capacity = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  const check: Check = {
    id: CHECK_ID,
    kind: CheckKind.Play,
    ask: question,
    expect: "yes",
    weight: CheckWeight.Normal,
    hard: false,
    note: "",
    origin: ORIGIN,
  };
  const played = await withLease(
    ctx,
    WINDOW_LABEL,
    (handle) =>
      handsOn.runHandsOnJudge(ctx, {
        run: chatRun(ask, question),
        root: ask.root,
        handle,
        questions: [check],
        quest,
        deadline: Date.now() + CHAT_JUDGE_MS,
        facetId: FACET,
        ...(judge ? { judge } : {}),
      }),
    { pooled: capacity?.headless !== false, retriesMs: options.retriesMs ?? WINDOW_RETRIES_MS },
  );
  if ("noWindow" in played) return refused(MESSAGE.noWindow(played.noWindow));
  return answerOf(played);
}

/** What the judge that played came back with, as the host records it. */
function answerOf(played: handsOn.HandsOnOutcome): ChatJudgeAnswer {
  const result = played.results[0];
  const answer = result?.answer === "yes" || result?.answer === "no" ? result.answer : null;
  // Nothing played (no window to drive, no engine that can play): the reason is the refusal.
  const notPlayed = played.trace ? "" : String(result?.reason ?? "");
  return {
    status: interactionStatus(result?.pass),
    answer,
    note: String(result?.note || result?.reason || ""),
    objective: played.objectives[CHECK_ID] ?? InteractionObjective.ModelSaid,
    trace: played.trace?.path ?? null,
    ...(notPlayed ? { refusal: notPlayed } : {}),
  };
}
