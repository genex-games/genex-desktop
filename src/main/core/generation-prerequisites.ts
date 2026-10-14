import { lstat } from "node:fs/promises";
import path from "node:path";
import { type CompiledStack, GameStack, isCompiledStack, stackOf } from "../../shared/game-project.ts";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import { PluginAccountState } from "../../shared/plugins.ts";
import type { StudioCore } from "../studio-core.ts";
import type { HarnessHostApi } from "../../shared/harness-api.ts";

type Readiness = HarnessHostApi["plugins.preflightMultiplayer"]["result"];

/** Why online work is or is not ready, as the director's decision card and its chat say it. */
export const MULTIPLAYER_REASON = {
  CppGame:
    "Genex online play adds Genex's JavaScript packages, which a C++ · raylib game cannot add. Build multiplayer in a browser (three.js) game.",
  RustGame:
    "Genex online play adds Genex's JavaScript packages, which a Rust · wgpu game cannot add. Build multiplayer in a browser (three.js) game.",
  NoManifest: "The game needs a regular package.json before SDK installation.",
  NoInstall: "Enable Genex's pinned SDK installation tool before online work.",
  Locked: "Connect or unlock Genex before online work; account readiness is unavailable.",
  NoPublish: "Enable the consented Genex draft publishing route before online work.",
  Ready:
    "Pinned SDK installation and a hosted draft route are available. Both still require their normal approvals; multiplayer needs a real hosted two-client test.",
} as const;

/** Why each compiled stack cannot take Genex's JavaScript packages: its own named reason. */
const COMPILED_REFUSAL = {
  [GameStack.RaylibCpp]: MULTIPLAYER_REASON.CppGame,
  [GameStack.RustWgpu]: MULTIPLAYER_REASON.RustGame,
} as const satisfies Record<CompiledStack, string>;

/**
 * Capability readiness never asserts remote authentication, install approval, or hosted gameplay
 * success. A compiled game (`stack`: C++ · raylib, Rust · wgpu) is answered first, by its
 * stack's reason: Genex's packages are JavaScript, and a package.json would not make them its own.
 */
export function multiplayerReadiness(facts: {
  manifest: boolean;
  install: boolean;
  publish: boolean;
  account: string | undefined;
  stack?: GameStack | null;
}): Readiness {
  if (facts.stack && isCompiledStack(facts.stack))
    return {
      ready: false,
      reason: COMPILED_REFUSAL[facts.stack],
      hostedVerified: false,
    };
  if (!facts.manifest)
    return {
      ready: false,
      reason: MULTIPLAYER_REASON.NoManifest,
      hostedVerified: false,
    };
  if (!facts.install)
    return {
      ready: false,
      reason: MULTIPLAYER_REASON.NoInstall,
      hostedVerified: false,
    };
  if (facts.account !== PluginAccountState.Unlocked)
    return {
      ready: false,
      reason: MULTIPLAYER_REASON.Locked,
      hostedVerified: false,
    };
  if (!facts.publish)
    return {
      ready: false,
      reason: MULTIPLAYER_REASON.NoPublish,
      hostedVerified: false,
    };
  return {
    ready: true,
    reason: MULTIPLAYER_REASON.Ready,
    hostedVerified: false,
  };
}

/** The stack of the library's game `project`, or null when the library has no such game. */
async function stackOfGame(core: StudioCore, project: string): Promise<GameStack | null> {
  const game = (await core.games.list().catch(() => [])).find((listed) => listed.name === project);
  return game ? stackOf(game.shape) : null;
}

/** Read host-owned capability and account state without network access, credentials, installs or publishing. */
export async function preflightMultiplayer(core: StudioCore, project: string, threadId?: string): Promise<Readiness> {
  const binding = await core.pluginBinding(project, threadId);
  if (!binding) throw new Error("Open a game before checking prerequisites");
  const manifest = await lstat(path.join(binding.directory, "package.json")).catch(() => null);
  // The bound game's own listing, as its builders are handed it (the web game's view, by stack).
  const stack = await stackOfGame(core, project);
  const tools = new Set(core.plugins.snapshot([], undefined, stack).tools.map((tool) => tool.name));
  return multiplayerReadiness({
    manifest: manifest?.isFile() === true,
    install: tools.has("genex__package"),
    publish: tools.has("genex__publish"),
    account: await core.plugins.accountState(GENEX_PLUGIN_ID),
    stack,
  });
}
