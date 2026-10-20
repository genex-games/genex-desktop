/**
 * Play-time AI for a Unity game in Play mode in the person's own editor. The game's `com.genex.ai`
 * package (`packages/com.genex.ai`) queues each `ai` line (docs/play-protocol.md) in
 * `Genex.AI.GenexAiRelay`; Studio's relay (`main/game-ai/bridge-editor.ts`) pulls them and pushes
 * the answers back through the editor's existing Pipeline server, so no port or token is added.
 *
 * Only host-owned C# runs: the pull is a fixed line, and a push carries the answers as base64, the
 * one thing interpolated into its code, so nothing a game or a model wrote ever becomes code. An
 * editor that is closed, plays nothing, or lacks the package answers no play.
 */
import type { PlayAiOutgoing } from "../../shared/play-protocol.ts";
import { isJsonObject } from "../../substrate/fsx.ts";
import { aiAnswerBatches, aiLineFromText } from "../../substrate/play-protocol-client.ts";
import { pipelineResultOf } from "./computer-play.ts";
import { type PipelineDeps, runCommand, systemPipelineDeps } from "./pipeline.ts";

/** The most lines one pull reads; the package holds no more than this unanswered. */
export const AI_RELAY_MAX_LINES = 8;
/** The most base64 characters one push carries; a reply as large as a model may give fits alone. */
export const AI_RELAY_MAX_PUSH_CHARS = 512 * 1024;
/** Pipeline's command that runs C#. */
const EVAL = "eval";

/** The fixed C# the relay runs in the editor. */
export const AiRelayCode = {
  /** `{playing, lines}`: whether a game plays, and each line it queued since, as its JSON text. */
  Pull: "return Genex.AI.GenexAiRelay.Pull();",
  /** Hands the playing game answers, given as base64 of their JSON; answers whether it took them. */
  push: (base64: string) => `return Genex.AI.GenexAiRelay.Push("${base64}");`,
} as const;

/**
 * The play-time AI channel of the Unity editor that has the project at `root` open. Neither call
 * waits for a busy editor: the relay asks again on its next tick.
 */
export function unityAiChannel(root: string, deps: PipelineDeps = systemPipelineDeps) {
  const evaluate = async (code: string, signal: AbortSignal): Promise<unknown> => {
    const answer = await runCommand(root, { command: EVAL, parameters: { code } }, deps, { signal, waitMs: 0 });
    return answer.ok ? pipelineResultOf(answer.result) : undefined;
  };
  return {
    /** The lines the playing game queued since the last pull, parsed; null while it plays nothing. */
    async pull(signal: AbortSignal): Promise<unknown[] | null> {
      const said = await evaluate(AiRelayCode.Pull, signal).catch(() => undefined);
      if (!isJsonObject(said) || said.playing !== true) return null;
      const lines = Array.isArray(said.lines) ? said.lines.slice(0, AI_RELAY_MAX_LINES) : [];
      return lines.map(aiLineFromText).filter((line) => line !== undefined);
    },
    /** Hands the playing game its answers, in order; false when the editor did not take them all. */
    async push(items: readonly PlayAiOutgoing[], signal: AbortSignal): Promise<boolean> {
      for (const base64 of aiAnswerBatches(items, AI_RELAY_MAX_PUSH_CHARS)) {
        const took = await evaluate(AiRelayCode.push(base64), signal).catch(() => undefined);
        if (took !== true) return false;
      }
      return true;
    },
  };
}
