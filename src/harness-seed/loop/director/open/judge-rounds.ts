/**
 * An open Loop's judges: the ones the game's engine plugin declares for it, which the lead may ask to
 * play the game (`judge_play`), each a blind judge asked one yes/no question. No judge plays unless
 * the lead asks (Loop phase 4): there is no round after a save point. A game the studio doesn't play
 * in an editor, or whose engine declares no judges (Unreal, a web game), has none of its own.
 */
import { editorPlayOf, judgesOf, type JudgeRef, servesEngineJudges } from "../../engine-judges.ts";
import { playedInEditor } from "../../folder-facts.ts";
import type { JudgeAsker, JudgePlay } from "../../judge-play.ts";
import type { LoopRun } from "../loop-run.ts";
import type { OpenLoop } from "./contract.ts";

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

/**
 * The judges' round after a save point no longer plays (Loop phase 4): a judge is the lead's to ask
 * for. The name stays for a kept older between.ts that still calls it, and it plays nobody.
 */
export async function judgeRound(_loopRun: LoopRun, _open: OpenLoop, _play?: JudgePlay): Promise<void> {}
