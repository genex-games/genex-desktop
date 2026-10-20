/**
 * `studio:game.crashes` (game-systems CRASH-5): the crash records a listed game keeps in its own
 * `.studio/crashes/`, newest first, for Live's crash card. A fixture-safe read: the game is the
 * one the registrar listed and checked, and nothing from the payload names a path.
 */
import type { GameCrashesAnswer } from "../../shared/crash-record.ts";
import { readGameCrashes } from "../core/game-crashes.ts";

/** Every record the listed game `game` keeps (its folder already checked against the allowed root). */
export function listedGameCrashes(game: { dir: string }): Promise<GameCrashesAnswer> {
  return readGameCrashes(game.dir, {});
}
