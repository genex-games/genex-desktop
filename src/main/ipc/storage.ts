/** What freeing space deletes, and deleting it, in one game or in all of them. */
import { PROJECT_NAME_RE } from "../../shared/game-folder-name.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** Why a storage request from the renderer is refused. */
const MESSAGE = {
  badGame: "A game name must be a game's folder name.",
} as const;

export interface StorageIpcDeps {
  core: Pick<StudioCore, "storageSpace" | "freeStorage">;
}

/** The game a payload names, undefined for every game; refused unless spelled as a game's name. */
function gameName(payload: unknown): string | undefined {
  const project = (payload as { project?: unknown } | null | undefined)?.project;
  if (project === undefined) return undefined;
  if (typeof project !== "string" || !PROJECT_NAME_RE.test(project)) throw new Error(MESSAGE.badGame);
  return project;
}

/** Register Settings → Storage's and the chat header's calls; the core checks a named game is listed. */
export function registerStorageIpc(handle: IpcHandle, { core }: StorageIpcDeps): void {
  handle("studio:storage", async (payload) => core.storageSpace(gameName(payload)));
  handle("studio:storage.free", async (payload) => core.freeStorage(gameName(payload)));
}
