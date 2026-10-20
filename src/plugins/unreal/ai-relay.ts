/**
 * Play-time AI for an Unreal game playing in the person's own editor (PIE). The game's GenexAI
 * plugin (`GenexAI/`, copied into a project's Plugins) queues each `ai` line (docs/play-protocol.md);
 * Studio's relay (`main/game-ai/bridge-editor.ts`) pulls them and pushes the answers back through
 * the Genex editor helper's relay toolset (`genex_ai.tools.GenexAiRelayTools`) on the editor's own
 * port, so no port or token is added. Answers travel as base64 of their JSON only. A project without
 * the plugin, an editor that plays nothing or one that does not answer is no play.
 */
import type { PlayAiOutgoing } from "../../shared/play-protocol.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { isJsonObject } from "../../substrate/fsx.ts";
import { aiAnswerBatches, aiLineFromText } from "../../substrate/play-protocol-client.ts";
import { callProjectTool, type EditorProject } from "./editor-mcp.ts";

/** The Genex editor helper's relay toolset, Studio's own. */
export const AI_RELAY_TOOLSET = "genex_ai.tools.GenexAiRelayTools";
/** Its two tools. Wire values: never rename one. */
export const AiRelayTool = { Pull: "ai_pull", Push: "ai_push" } as const;
export type AiRelayTool = (typeof AiRelayTool)[keyof typeof AiRelayTool];

/** The most lines one pull reads; the plugin holds no more than this unanswered. */
export const AI_RELAY_MAX_LINES = 8;
/** The most base64 characters one push carries; a reply as large as a model may give fits alone. */
export const AI_RELAY_MAX_PUSH_CHARS = 512 * 1024;
/** The longest relay answer read: every line it may carry at its cap, and room for the rest. */
export const AI_RELAY_MAX_PULL_CHARS = 2 * AI_RELAY_MAX_LINES * AI_RELAY_MAX_PUSH_CHARS;
/** How long one relay call may take on the editor's port, its session included. */
const RELAY_CALL_MS = 10 * SECOND_MS;

/** One relay tool call on the editor that has the project open; its answer is the tool's text. */
export type AiRelayCall = (tool: AiRelayTool, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** A relay tool's JSON answer as an object, or undefined: not text, over its cap or not JSON. */
function answerOf(said: unknown, maxChars: number): Record<string, unknown> | undefined {
  if (typeof said !== "string" || said.length > maxChars) return undefined;
  try {
    const parsed: unknown = JSON.parse(said);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The play-time AI channel of an Unreal editor, over its relay tool calls. */
export function unrealAiChannel(call: AiRelayCall) {
  return {
    /** The lines the playing game queued since the last pull, parsed; null while it plays nothing. */
    async pull(signal: AbortSignal): Promise<unknown[] | null> {
      const said = answerOf(await call(AiRelayTool.Pull, {}, signal).catch(() => undefined), AI_RELAY_MAX_PULL_CHARS);
      if (!said || said.playing !== true) return null;
      const lines = Array.isArray(said.lines) ? said.lines.slice(0, AI_RELAY_MAX_LINES) : [];
      return lines.map(aiLineFromText).filter((line) => line !== undefined);
    },
    /** Hands the playing game its answers, in order; false when the editor did not take them all. */
    async push(items: readonly PlayAiOutgoing[], signal: AbortSignal): Promise<boolean> {
      for (const answers of aiAnswerBatches(items, AI_RELAY_MAX_PUSH_CHARS)) {
        const said = answerOf(
          await call(AiRelayTool.Push, { answers }, signal).catch(() => undefined),
          AI_RELAY_MAX_PULL_CHARS,
        );
        if (said?.taken !== true) return false;
      }
      return true;
    },
  };
}

/** The relay's calls on the editor that has `project` open, once the helper there names that project. */
export function projectRelayCall(project: EditorProject, fetchImpl: typeof fetch = fetch): AiRelayCall {
  return (tool, args, signal) =>
    callProjectTool(project, { toolset: AI_RELAY_TOOLSET, tool, args, timeoutMs: RELAY_CALL_MS }, fetchImpl, signal);
}
