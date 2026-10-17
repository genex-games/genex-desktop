/**
 * Which engine a game builds in, as the app records it (`engine` in a game's studio.json, handed to
 * the harness on every `game.list` descriptor). A copy of the app's `shared/game-engine.ts`
 * vocabulary, held equal to it by `seed-contracts.test.ts`. A game with no engine record is a web
 * game; anything that would treat a game as a web page (the brief's template rules, the preview
 * health check, the web Loop) asks this first. `GameEngine` names the engines the seed's own code
 * knows; a linked game's engine is any id an installed plugin declares.
 */
import type { GameProject } from "../types/host-api.d.ts";

/** The engines a game can build in, by their wire names. */
export const GameEngine = { Web: "web", Unreal: "unreal", Godot: "godot" } as const;
export type GameEngine = (typeof GameEngine)[keyof typeof GameEngine];

/**
 * An engine's id as the app spells it: the id of the plugin that declares the engine (Unreal's is
 * `unreal`). Lowercase letters, digits and dashes, 2–40, a letter first.
 */
export const ENGINE_ID = /^[a-z][a-z0-9-]{1,39}$/;
export type EngineId = string;

/**
 * The engine a game descriptor says it builds in: the engine the app linked it to (Unreal, or any
 * engine an installed plugin declares), else the web.
 */
export function engineOfGame(game: Pick<GameProject, "engine"> | null | undefined): EngineId {
  const kind = game?.engine?.kind;
  return typeof kind === "string" && ENGINE_ID.test(kind) ? kind : GameEngine.Web;
}
