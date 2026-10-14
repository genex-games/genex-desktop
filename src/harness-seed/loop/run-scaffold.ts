/**
 * What a run asks `game.scaffold` for its game before anything is judged (the gauntlet, autopilot
 * and the director's setup). Its own module, so the seed modules that call it may be kept from
 * before compiled stacks and still link.
 */
import { ProjectStarter } from "./folder-facts.ts";
import { type BuildTarget, GameStack } from "./native-contract.ts";
import { type NativeDescriptor, scaffoldFor, stackOfShape } from "./native-loop.ts";

/** A `game.scaffold` ask beyond the name and title: a starter or compiled kind, and a compiled game's destinations. */
export interface RunScaffoldAsk {
  kind?: string;
  targets?: BuildTarget[];
}

/**
 * The ask for `project`: a game the library lists (`listed`, `game.list`'s answer) keeps its own
 * folder and stack, so a web game is asked for the web starter as always and a C++ · raylib or
 * Rust · wgpu game for nothing (the host refuses a web ask on a compiled folder, `stack-is-fixed`,
 * so a run resumed on one would never start); a new game is the compiled template its destinations
 * (`targets`) ask for, else the web starter.
 */
export function runScaffoldAsk(listed: unknown, project: string | undefined, targets: unknown): RunScaffoldAsk {
  const games: readonly NativeDescriptor[] = Array.isArray(listed) ? listed : [];
  const game = games.find((g) => g?.name === project);
  if (!game) return { kind: ProjectStarter.Web, ...scaffoldFor(targets) };
  return stackOfShape(game.shape) === GameStack.ThreeJs ? { kind: ProjectStarter.Web } : {};
}
