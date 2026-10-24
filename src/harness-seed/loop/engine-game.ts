/**
 * Whether a game's engine makes it an engine game rather than a web page: the app's
 * `isEngineGame`, held equal to it by `seed-contracts.test.ts`. A module of its own: a seed upgrade
 * keeps an older `game-engine.ts` the agent edited, so the parts that ask this import it from here,
 * and this reads `game-engine.ts` by namespace. Beside a kept older copy, which spells no engine id,
 * no game is an engine game here; that copy's own `engineOfGame` then reads it as before.
 */
import * as gameEngine from "./game-engine.ts";

/**
 * Whether `kind` names an engine game: an engine id other than the web's. What asks whether a game
 * is a web page asks this; only Unreal's own Loop and words ask for Unreal by name.
 */
export function isEngineGame(kind: unknown): kind is gameEngine.EngineId {
  const spelling: unknown = gameEngine.ENGINE_ID;
  if (typeof kind !== "string" || kind === gameEngine.GameEngine.Web) return false;
  return spelling instanceof RegExp && spelling.test(kind);
}
