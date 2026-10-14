/**
 * What the person's engine rows show for a Rust game (`studio:engine.state`): whether it builds
 * with Studio's engine or its own ejected copy (the person's eject as the profile records it, never
 * a `genex.toml` row a game wrote itself), and its trust flag as the profile holds it. A read:
 * nothing is written.
 */
import type { EngineState } from "../shared/game-conformance.ts";
import { GameStack, stackOf } from "../shared/game-project.ts";
import { type EngineEjections, engineEjectionsFor } from "./rust-eject.ts";
import { engineTrustFor, type EngineTrustStore } from "./rust-trust.ts";
import type { StudioCore } from "./studio-core.ts";

const MESSAGE = {
  notRust: (project: string) => `${project} is not a Rust game in the library`,
} as const;

/** What the read reaches: the library's Rust game, the profile's eject records and its trust flags. */
export interface EngineStateDeps {
  rustGame: (project: string) => Promise<{ dir: string } | null>;
  ejections: Pick<EngineEjections, "ejectedFrom">;
  trust: Pick<EngineTrustStore, "trustOf">;
}

/** `project`'s engine and trust flag; throws for a game that is not a Rust game of the library. */
export async function engineStateOf(deps: EngineStateDeps, project: string): Promise<EngineState> {
  const game = await deps.rustGame(project);
  if (!game) throw new Error(MESSAGE.notRust(project));
  const [ejectedFrom, trust] = await Promise.all([
    deps.ejections.ejectedFrom(project).catch(() => null),
    deps.trust.trustOf({ project, dir: game.dir }),
  ]);
  return { project, ejectedFrom, trusted: trust.trusted };
}

/** {@link engineStateOf} over the core's library, eject records and trust flags. */
export function engineStateFor(core: StudioCore, project: string): Promise<EngineState> {
  const rustGame = async (name: string) =>
    (await core.games.list()).find((game) => game.name === name && stackOf(game.shape) === GameStack.RustWgpu) ?? null;
  return engineStateOf({ rustGame, ejections: engineEjectionsFor(core), trust: engineTrustFor(core) }, project);
}
