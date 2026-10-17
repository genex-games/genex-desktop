/**
 * Bring back newer version on a rewind's line: the game files come back as they were just before
 * that rewind, and the chat stays rewound. The line itself changes when main records it.
 */
import type { StudioApi } from "../../shared/studio-api.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";

/** What the button asks for: the chat, and the rewind its line names. */
export interface RewindUndoRequest {
  threadId: string;
  rewindId: string;
}

/** Sends the chat's call; a refusal reaches the person as a problem. Answers whether it went through. */
export function bringBackNewer(
  studio: Pick<StudioApi, "undoRewind">,
  request: RewindUndoRequest,
  onNotice: Notify,
): Promise<boolean> {
  return studio.undoRewind(request.threadId, request.rewindId).then(
    () => true,
    (error: unknown) => {
      notifyProblem(onNotice)(error);
      return false;
    },
  );
}
