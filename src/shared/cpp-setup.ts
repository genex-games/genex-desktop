/** One managed C++ setup per profile: every destination this host can build, including judges' Web. */
import { GameStack } from "./game-project.ts";
import { setupTargets } from "./stack-setup.ts";
import type { ToolchainHost } from "./toolchain.ts";
import type { BuildTarget } from "./game-project.ts";

/** Setup scope is independent of a game's chosen destinations; unsupported hosts prepare nothing ({@link setupTargets} for raylib). */
export function cppSetupTargets(host: ToolchainHost | null): readonly BuildTarget[] {
  return setupTargets(GameStack.RaylibCpp, host);
}
