/**
 * Roblox Studio back at its editor before a publish. Studio publishes from its editor, never from a
 * play test, so a test running in the game's Studio is ended with `start_stop_play` and the publish
 * waits until Studio says it is editing again: ending a test is never the person's chore. Only
 * Studio's own state decides (`get_studio_state`: its mode, else a Client or Server data model),
 * never the Explorer's NetworkClient, which a place edited from Roblox shows while editing, or the
 * Test tab's Stop button. A Studio that can't be reached or can't say is left as it is.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { parseStudioState } from "./computer-play.ts";
import type { StudioClient, StudioToolResult } from "./studio-client.ts";
import { DataModel, STUDIO_ID_ARG, StudioTool } from "./studio-tools.ts";

/** How long Studio has to end a play test and be editing again. */
const EDIT_WAIT_MS = 30 * SECOND_MS;
/** How often Studio's mode is read while the test ends. */
const EDIT_POLL_MS = SECOND_MS / 2;
/** One read of Studio's state. */
const STATE_CALL_MS = 10 * SECOND_MS;
/** Studio's mode while it edits, as `get_studio_state` names it. */
const EDIT_MODE = "Edit";

/** What bringing Studio back to its editor needs: the game's Studio and a clock. */
export interface StudioEditDeps {
  studio: Pick<StudioClient, "callTool"> | undefined;
  /** The Studio holding the game, as the helper link has it bound. */
  studioId: string | undefined;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The text parts of a Studio answer, joined. */
function textOf(result: StudioToolResult): string {
  return result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/** Whether Studio is in a play test now; null when it can't say. */
async function testing(studio: Pick<StudioClient, "callTool">, studioId: string): Promise<boolean | null> {
  const args = { [STUDIO_ID_ARG]: studioId };
  const answer = await studio.callTool(StudioTool.GetStudioState, args, { timeoutMs: STATE_CALL_MS }).catch(() => null);
  if (!answer || answer.isError) return null;
  const state = parseStudioState(textOf(answer));
  if (state.mode) return state.mode !== EDIT_MODE;
  return state.dataModels.includes(DataModel.Client) || state.dataModels.includes(DataModel.Server);
}

/**
 * Studio at its editor: a running play test ended and waited out. True once Studio edits (or can't
 * say); false when it is still testing after {@link EDIT_WAIT_MS}.
 */
export async function backToEdit(deps: StudioEditDeps): Promise<boolean> {
  const { studio, studioId } = deps;
  if (!studio || !studioId) return true;
  if ((await testing(studio, studioId)) !== true) return true;
  const stop = { [STUDIO_ID_ARG]: studioId, is_start: false };
  await studio.callTool(StudioTool.StartStopPlay, stop, { timeoutMs: EDIT_WAIT_MS }).catch(() => null);
  const deadline = deps.now() + EDIT_WAIT_MS;
  while (deps.now() < deadline) {
    if ((await testing(studio, studioId)) !== true) return true;
    await deps.sleep(EDIT_POLL_MS);
  }
  return false;
}
