/**
 * A Loop lead's `judge_play` on a game the studio plays in its engine's editor (an Unreal game): a
 * blind judge plays it and answers one yes/no question, the same judge a web Loop's build and a
 * chat's `judge_play` use (`hands-on-judge.ts`). The studio hands a judge's computer the editor
 * play for such a game, so the leased window only names the judge's screen. Its answer goes to the
 * run's record like any judge's (`recordHandsOn`) and back to the lead in words. The judge never
 * sees the lead's code. The one Loop's open lead and the Unreal runner's lead both offer it.
 */
import { WINDOW_RETRIES_MS } from "./config.ts";
import { withLease } from "./evidence.ts";
import { type HandsOnOptions, type HandsOnOutcome, recordHandsOn, runHandsOnJudge } from "./hands-on-judge.ts";
import { HostMethod } from "./host-methods.ts";
import { InteractionObjective } from "./interaction-words.ts";
import { JUDGE_PLAY_ARGS, JUDGE_PLAY_DESCRIPTION, JUDGE_PLAY_TOOL, JUDGE_PLAY_WORDS } from "./judge-play-prompts.ts";
import { parseGoalState, questId, type Quest } from "./quest.ts";
import { ENGINE_JUDGE_WORDS } from "./engine-judges-prompts.ts";
import { type Check, CheckKind, CheckWeight } from "./spec.ts";
import { hasText } from "./text.ts";
import { MINUTE_MS } from "./time.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { JudgeRef, LiveToolSpec } from "../types/host-api.d.ts";

/** How long the judge may play: a director's playtest's default. */
const JUDGE_MS = 5 * MINUTE_MS;
/**
 * The moves the judge may make: walking a 3D level, turning and using things takes more than a web
 * page's dozen (a live Unreal judge ran out between two rooms), still within its few minutes.
 */
const JUDGE_MAX_ACTIONS = 30;
/** The longest question the judge is handed, in characters. */
const MAX_ASK_CHARS = 500;
/** Who put the question on the board, and the facet its frames are filed under. */
const ORIGIN = "loop-lead";
const FACET = "editor-judge";
/** The leased window's name in the window strip. */
const WINDOW_LABEL = "judge:editor";
/** `judge_play` as a lead's engine sees it. */
export const JUDGE_PLAY_SPEC: LiveToolSpec = {
  name: JUDGE_PLAY_TOOL,
  description: JUDGE_PLAY_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      ask: { type: "string", description: JUDGE_PLAY_ARGS.ask },
      goal_state: { type: "string", description: JUDGE_PLAY_ARGS.goalState },
    },
    required: ["ask"],
  },
};

export { JUDGE_PLAY_TOOL };

/** This copy plays a judge the lead names by id (`judge`) as that judge: `engine-judges.ts` reads it. */
export const SERVES_ENGINE_JUDGES = true;

/** The run, the game's folder and the clock a judge is asked under. */
export interface JudgeAsker {
  ctx: HarnessCtx;
  run: Run;
  root: string;
  now: () => number;
  /** The judges the game's engine plugin declares for it: a `judge` the lead names must be one. */
  judges?: readonly JudgeRef[];
  /** The latest a judge plays until: the Loop's working time, when it ends sooner than the judge's own. */
  until?: number;
}

/** Plays one judge on a leased window: `runHandsOnJudge` there, or why no window came. */
export type JudgePlay = (
  ctx: HarnessCtx,
  options: Omit<HandsOnOptions, "handle">,
) => Promise<HandsOnOutcome | { noWindow: string }>;

/** The judge on a window of the pool, as the chat's judge leases one. */
export const leasedJudge: JudgePlay = async (ctx, options) => {
  const capacity = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  return withLease(ctx, WINDOW_LABEL, (handle) => runHandsOnJudge(ctx, { ...options, handle }), {
    pooled: capacity?.headless !== false,
    retriesMs: WINDOW_RETRIES_MS,
  });
};

/** The goal the judge plays to, or why the goal state cannot be one; null when none was named. */
function questOf(question: string, goalState: unknown): Quest | { error: string } | null {
  const until = parseGoalState(typeof goalState === "string" ? goalState : "");
  if (until === null) return null;
  if ("error" in until) return { error: JUDGE_PLAY_WORDS.goalState(until.error) };
  return { id: questId(question, "goal"), until: until.until };
}

/** The question as the judge's board takes it. */
function checkOf(question: string): Check {
  return {
    id: questId(question, ORIGIN),
    kind: CheckKind.Play,
    ask: question,
    expect: "yes",
    weight: CheckWeight.Normal,
    hard: false,
    note: "",
    origin: ORIGIN,
  };
}

/** The judge's answer in the lead's words. */
function answerWords(played: HandsOnOutcome, check: Check): string {
  const result = played.results[0];
  const note = String(result?.note || result?.reason || "");
  if (!played.trace) return JUDGE_PLAY_WORDS.notPlayed(note);
  const answer = result?.answer === "yes" || result?.answer === "no" ? result.answer : null;
  if (!answer) return JUDGE_PLAY_WORDS.noAnswer(note);
  const verified = played.objectives[check.id] === InteractionObjective.StudioVerified;
  return JUDGE_PLAY_WORDS.answered(answer, verified, note);
}

/** Asks a blind judge from `judge_play`'s arguments; answers what it found, in words. */
export async function askJudge(asker: JudgeAsker, args: AnyRecord, play: JudgePlay = leasedJudge): Promise<string> {
  const question = hasText(args.ask) ? args.ask.trim().slice(0, MAX_ASK_CHARS) : "";
  if (!question) return JUDGE_PLAY_WORDS.noAsk;
  const quest = questOf(question, args.goal_state);
  if (quest && "error" in quest) return quest.error;
  const judge = hasText(args.judge) ? args.judge.trim() : "";
  const judges = asker.judges ?? [];
  if (judge && !judges.some((one) => one.id === judge)) return ENGINE_JUDGE_WORDS.unknownJudge(judge, judges);
  const check = checkOf(question);
  const played = await play(asker.ctx, {
    run: asker.run,
    root: asker.root,
    questions: [check],
    quest,
    deadline: Math.min(asker.now() + JUDGE_MS, asker.until ?? Number.POSITIVE_INFINITY),
    maxActions: JUDGE_MAX_ACTIONS,
    facetId: FACET,
    ...(judge ? { judge } : {}),
  });
  if ("noWindow" in played) return JUDGE_PLAY_WORDS.noWindow(played.noWindow);
  await recordHandsOn(asker.ctx, asker.run, played, [check]);
  return answerWords(played, check);
}
