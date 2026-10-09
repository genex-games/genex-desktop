/**
 * What an Unreal game's open editor is doing, as the Unreal plugin's `editor-activity` answers it:
 * whether a play session runs, and how many packages it holds unsaved. Every save of the editor's
 * work asks first, because the plugin's `save-all` ends a play session the person may be in, so a
 * reader takes "can't say" as "don't save". A chat turn's end save (`delegated-turn.ts`) and the
 * Unreal lead's save points (`save-point.ts`) read it here alike; it loads nothing of the Unreal Loop.
 *
 * No current module calls this: the editor lock's probe answers Genex what the editor
 * is doing. It stays because older copies of `delegated-turn.ts` and `save-point.ts` an agent kept
 * import it.
 */
import { isPlainRecord } from "../json.ts";

/** The plugin's tool, by its agent name (`seed-contracts.test.ts` holds it to the plugin's). Never rename the value. */
export const EDITOR_ACTIVITY_TOOL = "unreal__editor-activity";

/** What the editor is doing: a play session runs, and how many packages it holds unsaved. */
export type EditorActivity = { playing: boolean; dirty: number };

/** `editor-activity`'s answer, or null when it isn't `{pie, dirty}` with a count: the plugin can't say. */
export function editorActivityOf(answer: unknown): EditorActivity | null {
  if (!isPlainRecord(answer) || typeof answer.pie !== "boolean") return null;
  const { dirty } = answer;
  const counted = typeof dirty === "number" && Number.isFinite(dirty) && dirty >= 0;
  return counted ? { playing: answer.pie, dirty } : null;
}
