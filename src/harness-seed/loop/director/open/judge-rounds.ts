/**
 * An open Loop's judge rounds: after a turn that kept a save point, every judge the game's engine
 * plugin declares for it plays the game as that save point left it, one at a time, on the one play the
 * studio holds in the engine's editor. Each is a blind judge asked one yes/no question (`askJudge`):
 * its answer goes to the run's checks and opens the lead's next turn. A game the studio doesn't play
 * in an editor, or whose engine declares no judges (Unreal, a web game), has no rounds.
 *
 * A round keeps to the Loop's hours: none starts once the working time is nearly over or a finish was
 * asked for, and no judge plays past the working time. A stop, a hold or the Loop's close ends the
 * round before the next judge.
 */
import { editorPlayOf, judgesOf, type JudgeRef, servesEngineJudges } from "../../engine-judges.ts";
import { ENGINE_JUDGE_WORDS } from "../../engine-judges-prompts.ts";
import { playedInEditor } from "../../folder-facts.ts";
import { askJudge, type JudgeAsker, type JudgePlay, leasedJudge } from "../../judge-play.ts";
import { MINUTE_MS } from "../../time.ts";
import { closeUnderWay } from "../close-latch.ts";
import type { LoopRun } from "../loop-run.ts";
import { finishAsked } from "../wrap-up.ts";
import type { OpenLoop, OpenSavePoint } from "./contract.ts";

/** The least working time a round starts with: a judge needs a few minutes to play. */
export const ROUND_MIN_MS = 3 * MINUTE_MS;

/** Whether the studio plays the Loop's game in its engine's editor, where a judge can play it. */
export function judgedInEditor(loopRun: Pick<LoopRun, "game" | "gameFacts">): boolean {
  return playedInEditor({ ...editorPlayOf(loopRun.game), facts: loopRun.gameFacts });
}

/** The judges that play the Loop's game: its engine plugin's, when the studio plays it in an editor; none otherwise. */
export function loopJudges(loopRun: Pick<LoopRun, "game" | "gameFacts">): JudgeRef[] {
  if (!judgedInEditor(loopRun) || !servesEngineJudges()) return [];
  return judgesOf(loopRun.game);
}

/** The judge a lead's `judge_play` is asked under: the run, the game folder, the Loop's clock and the game's judges. */
export function leadAsker(loopRun: LoopRun): JudgeAsker {
  const now = () => (loopRun.open?.clock ?? Date).now();
  return { ctx: loopRun.ctx, run: loopRun.run, root: loopRun.projectDir, now, judges: loopJudges(loopRun) };
}

/** Whether the Loop is stopping, held or closing: no judge starts then. */
function stopped(loopRun: LoopRun, open: OpenLoop): boolean {
  const { ctx, state } = loopRun;
  if (ctx.cancelled === true || open.halted || open.refused) return true;
  return state.finished || Boolean(state.finish) || closeUnderWay(state);
}

/** Whether the Loop has the working time for a round: some left, and no finish asked for. */
async function hasTime(loopRun: LoopRun, open: OpenLoop): Promise<boolean> {
  if (loopRun.softDeadline - open.clock.now() < ROUND_MIN_MS) return false;
  return !(await finishAsked(loopRun));
}

/** One line the lead's next turn opens with. */
const carry = (open: OpenLoop, line: string): void => {
  open.journal.carried.push(line);
};

/** Why a round left judges unplayed: a stop, or the working time running out. */
const RoundEnd = { Stopped: "stopped", TimeUp: "time-up" } as const;
type RoundEnd = (typeof RoundEnd)[keyof typeof RoundEnd];

/** The judges a round left unplayed, and why. */
type RoundCut = { unplayed: JudgeRef[]; why: RoundEnd };

/** Each judge in turn on the save point, none once the working time is over; the ones left unplayed, and why. */
async function playEach(loopRun: LoopRun, open: OpenLoop, point: OpenSavePoint, play: JudgePlay): Promise<RoundCut> {
  const judges = loopJudges(loopRun);
  const asker = { ...leadAsker(loopRun), until: loopRun.softDeadline };
  for (const [i, judge] of judges.entries()) {
    if (stopped(loopRun, open)) return { unplayed: judges.slice(i), why: RoundEnd.Stopped };
    if (open.clock.now() >= loopRun.softDeadline) return { unplayed: judges.slice(i), why: RoundEnd.TimeUp };
    const ask = ENGINE_JUDGE_WORDS.roundAsk(judge, point);
    const answer = await askJudge(asker, { ask, judge: judge.id }, play);
    carry(open, ENGINE_JUDGE_WORDS.played(judge, point.label, answer));
  }
  return { unplayed: [], why: RoundEnd.Stopped };
}

/**
 * The round after a turn that kept a save point (the last one it kept): every judge in turn, each
 * answer kept for the lead's next turn; nothing for a game with no judges.
 */
export async function judgeRound(loopRun: LoopRun, open: OpenLoop, play: JudgePlay = leasedJudge): Promise<void> {
  const point = open.journal.savePoints.at(-1);
  if (!point || !loopJudges(loopRun).length || stopped(loopRun, open)) return;
  if (!(await hasTime(loopRun, open))) {
    carry(open, ENGINE_JUDGE_WORDS.noTime(point.label));
    return;
  }
  const { unplayed, why } = await playEach(loopRun, open, point, play);
  if (unplayed.length) {
    const words = why === RoundEnd.TimeUp ? ENGINE_JUDGE_WORDS.timeUp : ENGINE_JUDGE_WORDS.cut;
    carry(open, words(point.label, unplayed));
  }
  await loopRun.saveJournal().catch(() => {});
}
