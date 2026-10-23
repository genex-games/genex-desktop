/**
 * Live's own channels for a game on the stage. `studio:live.reloadAssets`: Live's Reload swapping a
 * game's changed assets into its running build (game systems C-19b, `main/asset-watch.ts`). The
 * person's act from the stage, native-classified: it writes into the copy the running game reads
 * and sends that game an op. `studio:live.prepare`: the background build of a compiled game's
 * folder Live's Reload then plays (`PreviewService.prepareLiveBuild`), for Web or Mac alone. The
 * game must be one the library lists inside the allowed root; everything else is the core's.
 */
import type { GameProject } from "../../shared/game-project.ts";
import type { LiveAssetsAnswer } from "../../shared/live-assets.ts";
import { isLivePrepareTarget, type LivePrepare, type LivePrepareTarget } from "../../shared/live-behind.ts";
import type { IpcHandle } from "./registrar.ts";

const MESSAGE = {
  noGame: "that game is not in the library",
  noTarget: "Live builds only its web view's and its Native view's destinations",
} as const;

/** A game folder's name as the library lists it: one path segment, never a dot name. */
const PROJECT_NAME = /^[^/\\\0]+$/;

/** What the channel reaches of the core. */
export interface LiveAssetsIpcCore {
  games: { list(): Promise<GameProject[]> };
  assertProjectAllowed(dir: string): Promise<unknown>;
  reloadLiveAssets(project: string): Promise<LiveAssetsAnswer>;
  prepareLiveBuild(project: string, target: LivePrepareTarget): Promise<LivePrepare>;
}

/** `payload.project` when it names a game the library lists inside the allowed root; throws otherwise. */
async function listedGame(core: LiveAssetsIpcCore, payload: unknown): Promise<string> {
  const holds = typeof payload === "object" && payload !== null && Object.hasOwn(payload, "project");
  const project: unknown = holds ? Reflect.get(payload, "project") : undefined;
  const named = typeof project === "string" && PROJECT_NAME.test(project) && project !== "." && project !== "..";
  if (!named) throw new Error(MESSAGE.noGame);
  const game = (await core.games.list()).find((item) => item.name === project);
  if (!game) throw new Error(MESSAGE.noGame);
  await core.assertProjectAllowed(game.dir);
  return game.name;
}

/** `payload.target` when it is Web or Mac; throws otherwise. */
function prepareTarget(payload: unknown): LivePrepareTarget {
  const target: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "target") : undefined;
  if (!isLivePrepareTarget(target)) throw new Error(MESSAGE.noTarget);
  return target;
}

/** Registers `studio:live.reloadAssets` and `studio:live.prepare`. */
export function registerLiveAssetsIpc(handle: IpcHandle, core: LiveAssetsIpcCore): void {
  handle("studio:live.reloadAssets", async (payload) => core.reloadLiveAssets(await listedGame(core, payload)));
  handle("studio:live.prepare", async (payload) => {
    const target = prepareTarget(payload);
    return core.prepareLiveBuild(await listedGame(core, payload), target);
  });
}
