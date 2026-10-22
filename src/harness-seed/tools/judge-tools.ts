/**
 * A judge that plays, for a direct engine's turn (Ollama): the same `judge_play` every session engine
 * is handed, run by the host (`judge.play`). A blind judge plays the game with this chat's model on a
 * hidden window and answers one yes/no question; the host records the outcome in the chat. A game
 * whose engine plugin declares judges may be played by one of them (`judge`, checked by the host).
 * A host without `judge.play` offers no tool here.
 *
 * A new module: the registry imports every `tools/*.ts`, so a kept older workspace without it simply
 * has no judge tool.
 */
import { ENGINE_JUDGE_WORDS } from "../loop/engine-judges-prompts.ts";
import { HostMethod } from "../loop/host-methods.ts";
import type { AnyRecord, HarnessTool, ToolCtx, ToolOutcome } from "../types/harness.d.ts";
import type { LiveToolResult } from "../types/host-api.d.ts";

const str = (description: string) => ({ type: "string", description });

/** What the model reads about the tool: an independent check of the game, by playing it. */
const DESCRIPTION =
  "Have an independent judge play this game and answer one yes/no question about it. Use it when the person asks for a change to be checked by someone other than you (a judge, a playtest, “make sure someone can win”). " +
  "The judge is blind: it sees only the game's screen, never the code, and plays the folder as it is now in a hidden window of its own. " +
  "When the question has a state the game reaches, pass goal_state: the studio checks it after every move, and a yes is verified by the studio. It takes a few minutes.";

/** The host's answer as the turn's outcome. */
function outcomeOf(answer: LiveToolResult): ToolOutcome | string {
  if (typeof answer === "string") return answer;
  return { ok: answer.isError !== true, content: answer.text };
}

/** Does this studio's host run a judge for a chat (a kept older host-methods.ts may not know it)? */
function hostHasJudge(): boolean {
  return Object.hasOwn(HostMethod, "JudgePlay");
}

export const tools: HarnessTool[] = hostHasJudge()
  ? [
      {
        name: "judge_play",
        description: DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            ask: str("one yes/no question the judge can settle by playing, e.g. “Can you reach the star and win?”"),
            goal_state: str(
              'optional JSON: the state the game reaches when the answer is yes, e.g. {"path":"flow.phase","equals":"won"}',
            ),
            judge: str(ENGINE_JUDGE_WORDS.chatArg),
          },
          required: ["ask"],
        },
        async execute(args: AnyRecord, ctx: ToolCtx) {
          if (!ctx.project) return "Open a project first";
          const answered = await ctx.call(HostMethod.JudgePlay, {
            project: ctx.project,
            ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
            ...(ctx.engine ? { engine: ctx.engine } : {}),
            ...(ctx.model ? { model: ctx.model } : {}),
            ...(ctx.effort ? { effort: ctx.effort } : {}),
            args,
          });
          if ("unavailable" in answered) return answered.unavailable;
          if ("answer" in answered) return outcomeOf(answered.answer);
          return "the judge answered nothing";
        },
      },
    ]
  : [];
