/** The harness's own changes: listed, undone, and the harness rolled back to a saved version. */
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

export interface LearningIpcDeps {
  core: StudioCore;
}

export function registerLearningIpc(handle: IpcHandle, { core }: LearningIpcDeps): void {
  handle("studio:selfchanges", async () => ({ changes: await core.selfChangeList() }));

  handle("studio:rollback", async (payload) => {
    await core.rollbackTo(payload.snapshotId);
    return true;
  });
  handle("studio:selfchange.undo", async (payload) => core.undoSelfChange(payload.snapshotId));
}
