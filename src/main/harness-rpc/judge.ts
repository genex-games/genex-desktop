/**
 * Harness RPC: `judge_play` for the harness's own tool loop (Ollama), the same tool session engines
 * are handed (`core/judge-play-tool.ts`): a blind judge plays the chat's game, with the chat's model,
 * and the outcome is recorded in that chat by the host. A game played in its engine's editor is
 * played there, and `args.judge` may name one of the judges its engine plugin declares.
 */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { servedAsWebGame } from "../../shared/project-facts.ts";
import { editorPlayPlugin } from "../core/editor-play-session.ts";
import { runJudgePlay, studioJudgeHost } from "../core/judge-play-tool.ts";
import type { StudioCore } from "../studio-core.ts";

/** Why there is no judge for this call. */
const MESSAGE = {
  noChat: "a judge's play is recorded in a chat, and this call names none",
  noEngine: "a judge plays with the chat's model, and this call names none",
  notWindowed:
    "the studio plays this game neither in a window nor in an editor a plugin that is on plays, so no judge can play it here",
  otherChat: "a judge's play is recorded in this game's own chat, and this call names another",
} as const;

/** Is `threadId` a chat of `project`? The harness is the agent's: its line goes to no other chat. */
async function chatOf(core: StudioCore, project: string, threadId: string): Promise<boolean> {
  const record = await core.store.getRecord(threadId).catch(() => null);
  return record?.metadata?.project === project;
}

/** `judge.play`: the chat's judge for the harness's own loop, recorded in that game's own chat. */
export function judgeRpc(core: StudioCore) {
  return {
    [HostMethod.JudgePlay]: async (p) => {
      if (!p.threadId) return { unavailable: MESSAGE.noChat };
      if (!p.engine) return { unavailable: MESSAGE.noEngine };
      if (!(await chatOf(core, p.project, p.threadId))) return { unavailable: MESSAGE.otherChat };
      const game = (await core.games.list()).find((entry) => entry.name === p.project);
      if (!game) return { unavailable: MESSAGE.notWindowed };
      const played = servedAsWebGame(game) || (await editorPlayPlugin(core, p.project).catch(() => null)) !== null;
      if (!played) return { unavailable: MESSAGE.notWindowed };
      const caller = {
        project: p.project,
        root: core.games.dirFor(p.project),
        threadId: p.threadId,
        engine: p.engine,
        model: p.model,
        effort: p.effort,
      };
      return { answer: await runJudgePlay(studioJudgeHost(core), p.args ?? {}, caller) };
    },
  } satisfies Partial<HarnessHostHandlers>;
}
