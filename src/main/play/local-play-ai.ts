/**
 * Play-time models for a game being made, played as its own packaged app (`local-plays.ts`). The
 * app is the one Publish sends, and on genex.games it would ask for the budget a player approved.
 * Started from the game's own folder it is handed Live's practice helper instead, the one a play
 * in the game's editor is named (`core/practice-handoff.ts`): its key in the app's environment and
 * its port opened in the app's sandbox, so what the person chose in Live's bar (practice answers,
 * their own plan, real models for a cap) answers this play too, with no page on genex.games, no
 * declared budget and no credits of anyone's.
 *
 * Only a game folder's own app is handed one, and only while Live holds a helper for that game
 * (its card is shown and its code calls a model). A game a player installed from Play goes through
 * another launcher that has no such step. The app is given nothing else of Genex's here: no API
 * address and no sign-in, so it can reach the helper and nothing more.
 *
 * Windows cannot: a game's AppContainer reaches no port on this computer, so no key is handed and
 * the app's calls find no model; the game is checked in its editor there.
 */
import { StudioPlatform } from "../../shared/boot.ts";
import type { GamePractice } from "../../substrate/plugins/native-process.ts";

const MESSAGE = {
  windows: (project: string) =>
    `[practice] ${project}: its packaged app is handed no practice helper on Windows (a game's sandbox reaches no port on this computer); check its AI in the editor's play`,
} as const;

/** What handing a game folder's own app its helper needs. */
export interface LocalPlayAiDeps {
  /** The system Genex runs on. */
  platform: NodeJS.Platform;
  /** The key of the helper Live holds for `project` now (`EditorPractice.keyOf`), or null. */
  heldKey(project: string): string | null;
  log(line: string): void;
}

/**
 * The practice helper `project`'s own packaged app is handed for a play that starts now, or null:
 * Live holds none for the game, or this system's game sandbox cannot reach one (said in the log).
 */
export function localPlayAi(deps: LocalPlayAiDeps, project: string): GamePractice | null {
  const key = deps.heldKey(project);
  if (key === null) return null;
  if (deps.platform === StudioPlatform.Windows) {
    deps.log(MESSAGE.windows(project));
    return null;
  }
  return { key };
}
