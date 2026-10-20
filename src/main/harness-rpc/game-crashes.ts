/**
 * The harness's `game.crashes` (game-systems CRASH-5): a game's kept crash records, newest first,
 * read from its own `.studio/crashes/` (`core/game-crashes.ts`). The game is checked like every
 * root (in the library, inside the allowed root); no path from the params is ever opened.
 */
import type { GameCrashesAnswer } from "../../shared/crash-record.ts";
import type { HarnessParams, HostMethod } from "../../shared/harness-api.ts";
import { readGameCrashes } from "../core/game-crashes.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** `game.crashes`: the records `since` or the one `id` names, at most `GAME_CRASHES_MAX`. */
export async function gameCrashes(
  core: Pick<StudioCore, "games" | "assertProjectAllowed">,
  x: Pick<CoreInternals, "assertHarnessRoot">,
  p: HarnessParams<typeof HostMethod.GameCrashes>,
): Promise<GameCrashesAnswer> {
  await x.assertHarnessRoot(p.project, null);
  const dir = core.games.dirFor(p.project);
  await core.assertProjectAllowed(dir);
  return readGameCrashes(dir, { since: p.since ?? undefined, id: p.id ?? undefined });
}
