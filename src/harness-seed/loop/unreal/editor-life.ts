/**
 * Whether the game's Unreal is there, as the Unreal plugin's `editor-state` says: it answers; it is
 * busy (its editor process runs, but its game thread answers nothing: a long `run_script`, an
 * import, a play session's warm-up, a big save); it is gone (no editor process of the project runs:
 * it crashed or quit); or the plugin can't tell. Only "gone" is a crash: a busy editor holds work
 * nobody saved, and ending it would lose that work.
 *
 * A module of its own: `restore.ts` is a module the agent may have kept from before, and a kept copy
 * exports only what it did then, so a name the lead newly needs comes from here.
 *
 * No current module calls this: Genex's `health` moment, which the Unreal plugin's
 * `editor-state` answers, took it over. It stays because older copies of `lead-turn.ts` and
 * `restore.ts` an agent kept import it.
 */
import { SECOND_MS } from "../time.ts";
import type { Lead } from "./lead-journal.ts";
import { unrealTool } from "./lead-steps.ts";
import { UnrealLoopTool } from "./live-contract.ts";

/** Where the game's Unreal stands. Never rename a value. */
export const EditorLife = {
  Answers: "answers",
  /** Its editor process runs, and it answers nothing yet. */
  Busy: "busy",
  /** No editor process of the project runs, and it answers nothing. */
  Gone: "gone",
  /** It answers nothing, and the plugin can't tell whether its process runs (or can't be asked at all). */
  Unknown: "unknown",
} as const;
export type EditorLife = (typeof EditorLife)[keyof typeof EditorLife];

/**
 * Unreal is gone only when it misses this many answers in a row, this far apart: one ask gives up
 * within a second, and an editor whose process just ended may still have answered a moment before.
 */
const GONE_CHECKS = 3;
const GONE_CHECK_GAP_MS = 5 * SECOND_MS;

/** What reading the game's Unreal needs: its host and game, and the clock its checks wait on. */
export type EditorWatch = Pick<Lead, "ctx" | "run" | "threadId" | "clock">;

/** One `editor-state` read: whether Unreal answers (null: the plugin couldn't be asked), and whether its process runs (null: can't tell). */
async function readState(lead: EditorWatch): Promise<{ answering: boolean | null; running: boolean | null }> {
  const state = (await unrealTool(lead, UnrealLoopTool.EditorState).catch(() => null)) as AnyState | null;
  const answering = typeof state?.answering === "boolean" ? state.answering : null;
  const running = typeof state?.running === "boolean" ? state.running : null;
  return { answering, running };
}
type AnyState = { answering?: unknown; running?: unknown };

/**
 * Where the game's Unreal stands now: it answers within {@link GONE_CHECKS} asks; it is busy as soon
 * as one ask finds its process running; else gone when the last ask found no process of it, and
 * unknown when the plugin couldn't say.
 */
export async function editorLife(lead: EditorWatch): Promise<EditorLife> {
  for (let check = 1; ; check += 1) {
    const { answering, running } = await readState(lead);
    if (answering === true) return EditorLife.Answers;
    if (running === true) return EditorLife.Busy;
    if (answering === null) return EditorLife.Unknown;
    if (check >= GONE_CHECKS) return running === false ? EditorLife.Gone : EditorLife.Unknown;
    await lead.clock.sleep(GONE_CHECK_GAP_MS);
  }
}
