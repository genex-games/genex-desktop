/**
 * The build-lane seam over a C++ lane a test stands in: raylib's lane is the only one registered,
 * so a raylib game builds through `cpp` exactly as the core's seam builds it, and a Rust game is
 * refused `lane-missing`. The stand-in is called when a build is asked for, so a test may still
 * mock its `ensure` afterwards.
 */
import type { CppBuilds } from "../../src/main/cpp-build.ts";
import { GameBuildLanes, raylibLane } from "../../src/main/game-build.ts";
import { GameStack } from "../../src/shared/game-project.ts";

/** The seam with `cpp` as raylib's lane; a stand-in without `cancelAll` or `sweep` cancels and sweeps nothing. */
export function raylibLanes(
  cpp: Pick<CppBuilds, "ensure"> & Partial<Pick<CppBuilds, "cancelAll" | "sweep">>,
): GameBuildLanes {
  return new GameBuildLanes({
    [GameStack.RaylibCpp]: raylibLane({
      ensure: (input, options) => cpp.ensure(input, options),
      cancelAll: () => cpp.cancelAll?.(),
      sweep: async () => (cpp.sweep ? cpp.sweep() : 0),
    }),
  });
}
